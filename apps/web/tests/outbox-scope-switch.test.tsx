import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { QW } from '@/lib/queueWords';
import { QueueUnreadable } from '@/layout/QueueUnreadable';
import { LeaveUnkept, UnkeptStay } from '@/layout/LeaveUnkept';
import { dailyLogKey } from '@/store/dailyLogDraft';

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
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

  it('a persona switch with acts this phone did not keep asks first; Cancel keeps them, Continue switches and says how many were lost (#1028 r2, 4330762383)', async () => {
    signedInOnP1([]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().startActivity('A-2');
    expect(useStore.getState().toast).toBe(QW.notKept.en);
    act(() => useStore.getState().setRole('pmc'));
    expect(useStore.getState().leaveConfirm).toEqual({ action: 'persona', role: 'pmc' });
    expect(useStore.getState().role).toBe('engineer');
    expect(useStore.getState().outbox).toEqual([expect.objectContaining({ activityId: 'A-2' })]);
    render(<LeaveUnkept />);
    expect(screen.getByTestId('leave-unkept').textContent).toContain(QW.leaveTitle.en.replace('{n}', '1'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useStore.getState().leaveConfirm).toBeNull();
    expect(useStore.getState().role).toBe('engineer');
    expect(useStore.getState().outbox).toEqual([expect.objectContaining({ activityId: 'A-2' })]);
    act(() => useStore.getState().setRole('pmc'));
    fireEvent.click(screen.getByRole('button', { name: QW.leaveContinue.en }));
    expect(useStore.getState().role).toBe('pmc');
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().toast).toBe(QW.unkeptLost.en.replace('{n}', '1'));
  });

  it('a switch with acts this phone did not keep asks first; Cancel stays, Continue switches and says how many were lost', async () => {
    const gw = signedInOnP1([]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().startActivity('A-2');
    expect(useStore.getState().toast).toBe(QW.notKept.en);
    expect(await useStore.getState().switchProject(P2)).toBe('asked');
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

  it('a reload or closed tab with acts this phone did not keep is asked by the browser; with none it is not (#1028 r2 audit)', () => {
    signedInOnP1([]);
    render(<LeaveUnkept />);
    const leave = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    expect(leave()).toBe(false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().startActivity('A-2');
    expect(leave()).toBe(true);
  });

  /** one act this phone did not keep (every write refused while it was made) */
  function oneUnkept() {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().startActivity('A-2');
    write.mockRestore();
    expect(useStore.getState().toast).toBe(QW.notKept.en);
  }
  const keptA2 = () => expect(useStore.getState().outbox).toEqual([expect.objectContaining({ activityId: 'A-2' })]);

  it('a tap on the persona already active changes nothing and lets nothing go (#1028 r2 check G1)', () => {
    signedInOnP1([]);
    oneUnkept();
    act(() => useStore.getState().setRole('engineer'));
    expect(useStore.getState().leaveConfirm).toBeNull();
    expect(useStore.getState().sessionToken).toBe(token);
    expect(useStore.getState().sessionUserId).toBe(USER);
    keptA2();
    expect(useStore.getState().queueUnkept).toHaveLength(1);
  });

  it('a sign-in from inside the project as someone else asks first; Cancel keeps this session, Continue adopts it (#1028 r2 check G2)', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { login: ReturnType<typeof vi.fn> };
    const other = `h.${btoa(JSON.stringify({ sub: 'u-other' }))}.s`;
    gw.login = vi.fn(async () => ({ role: 'engineer', token: other, projectId: P1 }));
    oneUnkept();
    render(<LeaveUnkept />);
    await act(async () => { useStore.getState().login('other@example.com', 'pw'); });
    await vi.waitFor(() => expect(useStore.getState().leaveConfirm).toEqual(expect.objectContaining({ action: 'signIn' })));
    expect(useStore.getState().sessionToken).toBe(token);
    expect(useStore.getState().access.sending).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useStore.getState().leaveConfirm).toBeNull();
    expect(useStore.getState().sessionToken).toBe(token);
    keptA2();
    await act(async () => { useStore.getState().login('other@example.com', 'pw'); });
    await vi.waitFor(() => expect(useStore.getState().leaveConfirm).toEqual(expect.objectContaining({ action: 'signIn' })));
    fireEvent.click(screen.getByRole('button', { name: QW.leaveContinue.en }));
    expect(useStore.getState().sessionToken).toBe(other);
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().toast).toBe(QW.unkeptLost.en.replace('{n}', '1'));
  });

  it.each([
    ['email code', (gw: Record<string, unknown>, answer: unknown) => {
      gw.emailOtpVerify = vi.fn(async () => answer);
      useStore.setState((st) => { st.access.email = 'other@example.com'; st.access.otp = '1234'; });
      useStore.getState().emailOtpVerify();
    }],
    ['password setup', (gw: Record<string, unknown>, answer: unknown) => {
      gw.passwordCredentialComplete = vi.fn(async () => answer);
      useStore.setState((st) => { st.access.passwordSetupToken = 'setup-1'; });
      useStore.getState().completePasswordSetup('a-long-password-1', 'a-long-password-1');
    }],
    ['phone code', (gw: Record<string, unknown>, answer: unknown) => {
      gw.verifyOtp = vi.fn(async () => answer);
      useStore.setState((st) => { st.access.who = 'team'; st.access.phone = '9999999999'; st.access.otp = '1234'; st.access.codeLength = 4; });
      useStore.getState().otpVerify();
    }],
  ] as const)('a %s sign-in as someone else asks first, saves no session while asked, and Continue adopts it (#1028 r2 re-check G4)', async (_label, signIn) => {
    const gw = signedInOnP1([]) as unknown as Record<string, unknown>;
    const other = `h.${btoa(JSON.stringify({ sub: 'u-other' }))}.s`;
    oneUnkept();
    await act(async () => { signIn(gw, { role: 'engineer', token: other, projectId: P1 }); });
    await vi.waitFor(() => expect(useStore.getState().leaveConfirm).toEqual(expect.objectContaining({ action: 'signIn' })));
    expect(useStore.getState().sessionToken).toBe(token);
    // held, not adopted: a reload now could not restore the other person's session
    expect(sessionStorage.getItem('vitan.session.v1')).toBeNull();
    keptA2();
    act(() => useStore.getState().confirmLeave());
    expect(useStore.getState().sessionToken).toBe(other);
    expect(useStore.getState().outbox).toEqual([]);
  });

  it('a sign-in answer that lands while another question is open never replaces it, and is not adopted (#1028 r2 re-check G3)', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { login: ReturnType<typeof vi.fn> };
    const other = `h.${btoa(JSON.stringify({ sub: 'u-other' }))}.s`;
    gw.login = vi.fn(async () => ({ role: 'engineer', token: other, projectId: P1 }));
    oneUnkept();
    expect(await useStore.getState().switchProject(P2)).toBe('asked');
    await act(async () => { useStore.getState().login('other@example.com', 'pw'); });
    await vi.waitFor(() => expect(gw.login).toHaveBeenCalled());
    await act(async () => {});
    expect(useStore.getState().leaveConfirm).toEqual(expect.objectContaining({ action: 'switch', projectId: P2 }));
    expect(useStore.getState().sessionToken).toBe(token);
    expect(sessionStorage.getItem('vitan.session.v1')).toBeNull();
    keptA2();
  });

  it('archiving the open project while another question is open never replaces it, and sends nothing (#1028 r2 re-check G3)', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { deleteProject: ReturnType<typeof vi.fn> };
    gw.deleteProject = vi.fn(async () => {});
    oneUnkept();
    expect(await useStore.getState().switchProject(P2)).toBe('asked');
    act(() => useStore.getState().deleteProject('o', P1));
    expect(useStore.getState().leaveConfirm).toEqual(expect.objectContaining({ action: 'switch', projectId: P2 }));
    expect(gw.deleteProject).not.toHaveBeenCalled();
  });

  it('after a sign-out on a push-capable browser, the next session asks again: the finished teardown is not still under way (#1028 r2 re-check G3)', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { pushUnlink?: ReturnType<typeof vi.fn> };
    gw.pushUnlink = vi.fn(async () => ({}));
    vi.stubGlobal('navigator', { ...globalThis.navigator, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null } }) } });
    vi.stubGlobal('PushManager', function PushManager() {} as unknown);
    act(() => useStore.getState().requestSignOut());
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBeNull());
    // signed in again on P1, an act not kept: a switch asks
    useStore.setState({ sessionToken: token, sessionUserId: USER, activeProjectId: P1, role: 'engineer' });
    useStore.getState().hydrateOutbox();
    oneUnkept();
    expect(await useStore.getState().switchProject(P2)).toBe('asked');
  });

  it('a sign-in to the same person and project is adopted without a question, and keeps the acts', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { login: ReturnType<typeof vi.fn> };
    gw.login = vi.fn(async () => ({ role: 'engineer', token, projectId: P1 }));
    oneUnkept();
    await act(async () => { useStore.getState().login('me@example.com', 'pw'); });
    await vi.waitFor(() => expect(gw.login).toHaveBeenCalled());
    await act(async () => {});
    expect(useStore.getState().leaveConfirm).toBeNull();
    keptA2();
  });

  it('a switch the person continued asks nothing again while it is out, and leaves no question behind (#1028 r2 check G3)', async () => {
    const gw = signedInOnP1([]);
    let land!: () => void;
    gw.switchProject = vi.fn((projectId: string) => new Promise((done) => { land = () => done({ role: 'engineer', token, projectId }); }));
    oneUnkept();
    expect(await useStore.getState().switchProject(P2)).toBe('asked');
    act(() => useStore.getState().confirmLeave());
    expect(gw.switchProject).toHaveBeenCalledWith(P2);
    // a second tap while the first switch is out: it goes with the leave already agreed, and no question opens
    act(() => { void useStore.getState().switchProject('p-3'); });
    expect(useStore.getState().leaveConfirm).toBeNull();
    act(() => useStore.getState().setRole('pmc'));
    expect(useStore.getState().leaveConfirm).toBeNull();
    act(() => useStore.getState().requestSignOut());
    expect(useStore.getState().leaveConfirm).toBeNull();
    await act(async () => { land(); });
    expect(useStore.getState().leaveConfirm).toBeNull();
  });

  it('a question is closed when the scope it asked about is let go: the archive’s own switch lands under it (#1028 r2 check G3)', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { deleteProject: ReturnType<typeof vi.fn> };
    let archived!: () => void;
    gw.deleteProject = vi.fn(() => new Promise<void>((done) => { archived = done; }));
    useStore.setState({ memberships: [{ projectId: P1, short: 'P1' }, { projectId: P2, short: 'P2' }] as never });
    // the archive is sent with nothing unkept; an act is then not kept, and a switch asks
    act(() => useStore.getState().deleteProject('o', P1));
    expect(gw.deleteProject).toHaveBeenCalled();
    oneUnkept();
    expect(await useStore.getState().switchProject('p-3')).toBe('asked');
    // the archive answers: its switch goes on (the project is gone), and lets the acts go with the question
    await act(async () => { archived(); });
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe(P2));
    expect(useStore.getState().leaveConfirm).toBeNull();
  });

  it('a later leave never replaces an open question: a sign-out stays the question asked (#1028 r2 check G4)', async () => {
    signedInOnP1([]);
    oneUnkept();
    act(() => useStore.getState().requestSignOut());
    expect(useStore.getState().leaveConfirm).toEqual({ action: 'signOut' });
    expect(await useStore.getState().switchProject(P2)).toBe('asked');
    act(() => useStore.getState().setRole('pmc'));
    expect(useStore.getState().leaveConfirm).toEqual({ action: 'signOut' });
    act(() => useStore.getState().confirmLeave());
    expect(useStore.getState().sessionToken).toBeNull();
    expect(useStore.getState().activeProjectId).toBe(P1);
  });

  it('a later leave never replaces an open question: a switch stays the question asked, through a sign-out tap (#1028 r2 check G4)', async () => {
    const gw = signedInOnP1([]);
    oneUnkept();
    expect(await useStore.getState().switchProject(P2)).toBe('asked');
    act(() => useStore.getState().requestSignOut());
    expect(useStore.getState().leaveConfirm).toEqual(expect.objectContaining({ action: 'switch', projectId: P2 }));
    expect(useStore.getState().sessionToken).toBe(token);
    act(() => useStore.getState().confirmLeave());
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe(P2));
    expect(gw.switchProject).toHaveBeenCalledWith(P2);
    expect(useStore.getState().sessionToken).toBe(token);
  });

  it('archiving the open project with acts this phone did not keep asks before the archive is sent (#1028 r2 check G5)', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { deleteProject: ReturnType<typeof vi.fn> };
    gw.deleteProject = vi.fn(async () => {});
    useStore.setState({ memberships: [{ projectId: P1, short: 'P1' }, { projectId: P2, short: 'P2' }] as never });
    oneUnkept();
    act(() => useStore.getState().deleteProject('o', P1));
    expect(useStore.getState().leaveConfirm).toEqual({ action: 'archive', orgId: 'o', projectId: P1 });
    expect(gw.deleteProject).not.toHaveBeenCalled();
    act(() => useStore.getState().cancelLeave());
    expect(gw.deleteProject).not.toHaveBeenCalled();
    keptA2();
    act(() => useStore.getState().deleteProject('o', P1));
    act(() => useStore.getState().confirmLeave());
    expect(gw.deleteProject).toHaveBeenCalledWith('o', P1);
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe(P2));
    expect(useStore.getState().leaveConfirm).toBeNull();
    expect(useStore.getState().outbox).toEqual([]);
  });

  it('while any act is not kept the screen says so, singular and plural, until it is stored (#1028 r2 check G6)', () => {
    signedInOnP1([]);
    render(<UnkeptStay />);
    expect(screen.queryByTestId('unkept-stay')).toBeNull();
    act(() => oneUnkept());
    expect(screen.getByTestId('unkept-stay').textContent).toBe(QW.unkeptStayOne.en);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    act(() => useStore.getState().startActivity('A-3'));
    write.mockRestore();
    expect(screen.getByTestId('unkept-stay').textContent).toBe(QW.unkeptStay.en.replace('{n}', '2'));
    // a write that lands stores them all: the line goes
    act(() => useStore.getState().startActivity('A-4'));
    expect(screen.queryByTestId('unkept-stay')).toBeNull();
  });

  it('on a push-capable browser a persona switch the person continued asks nothing again during its unlink, and counts what it lets go when it runs', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { pushUnlink?: ReturnType<typeof vi.fn> };
    gw.pushUnlink = vi.fn(async () => ({}));
    let ready!: (v: unknown) => void;
    vi.stubGlobal('navigator', { ...globalThis.navigator, serviceWorker: { ready: new Promise((r) => { ready = r; }) } });
    vi.stubGlobal('PushManager', function PushManager() {} as unknown);
    oneUnkept();
    act(() => useStore.getState().setRole('pmc'));
    const generation = useStore.getState().projectScopeGeneration;
    act(() => useStore.getState().confirmLeave());
    // the unlink is out: the role has not changed yet, and a second tap asks nothing and starts no second teardown
    // (#1028 r2 re-check G2)
    expect(useStore.getState().role).toBe('engineer');
    act(() => useStore.getState().setRole('pmc'));
    expect(useStore.getState().leaveConfirm).toBeNull();
    await act(async () => { ready({ pushManager: { getSubscription: async () => null } }); });
    await vi.waitFor(() => expect(useStore.getState().role).toBe('pmc'));
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().toast).toBe(QW.unkeptLost.en.replace('{n}', '1'));
    expect(useStore.getState().leaveConfirm).toBeNull();
    // one teardown: the scope moved once, and a load that lands now is not let go by a second
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(useStore.getState().projectScopeGeneration).toBe(generation + 1);
  });

  /** a push-capable browser whose unlinks each wait until the test answers them; the 1.5 s cap never fires */
  function heldUnlinks(gw: ReturnType<typeof signedInOnP1> & { pushUnlink?: ReturnType<typeof vi.fn> }) {
    const unlinks: (() => void)[] = [];
    gw.pushUnlink = vi.fn(() => new Promise<void>((done) => { unlinks.push(() => done()); }));
    vi.stubGlobal('navigator', { ...globalThis.navigator, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/e' }) } }) } });
    vi.stubGlobal('PushManager', function PushManager() {} as unknown);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    return unlinks;
  }

  it('two persona switches out at once: only the newest applies, so a tap on it after the older one ends is not applied twice (#1028 r2 G1/G2 check G2, Q1)', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { pushUnlink?: ReturnType<typeof vi.fn> };
    const unlinks = heldUnlinks(gw);
    const generation = useStore.getState().projectScopeGeneration;
    act(() => useStore.getState().setRole('pmc'));
    await vi.waitFor(() => expect(unlinks).toHaveLength(1));
    act(() => useStore.getState().setRole('client'));
    await vi.waitFor(() => expect(unlinks).toHaveLength(2));
    // the pmc switch's unlink answers first: it was replaced by the client one, so it applies nothing
    await act(async () => { unlinks[0](); });
    await act(async () => { await Promise.resolve(); });
    expect(useStore.getState().role).toBe('engineer');
    // a tap on client while its switch is still out starts nothing
    act(() => useStore.getState().setRole('client'));
    await act(async () => { unlinks[1](); });
    await vi.waitFor(() => expect(useStore.getState().role).toBe('client'));
    await act(async () => { await Promise.resolve(); });
    expect(useStore.getState().projectScopeGeneration).toBe(generation + 1);
    expect(gw.pushUnlink).toHaveBeenCalledTimes(2);
  });

  it('a persona switch out when a sign-out ends is ended with it, so a tap on that persona after the sign-out applies once (#1028 r2 G1/G2 check G2, Q2)', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { pushUnlink?: ReturnType<typeof vi.fn> };
    const unlinks = heldUnlinks(gw);
    act(() => useStore.getState().requestSignOut());
    await vi.waitFor(() => expect(unlinks).toHaveLength(1));
    act(() => useStore.getState().setRole('pmc'));
    await vi.waitFor(() => expect(unlinks).toHaveLength(2));
    await act(async () => { unlinks[0](); });
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBeNull());
    // no session now: the tap applies at once
    act(() => useStore.getState().setRole('pmc'));
    expect(useStore.getState().role).toBe('pmc');
    const generation = useStore.getState().projectScopeGeneration;
    // the switch that was out during the sign-out answers late: it applies nothing
    await act(async () => { unlinks[1](); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(useStore.getState().projectScopeGeneration).toBe(generation);
  });

  it('a persona switch out when a sign-out ends never applies after it: the signed-out app stays signed out (#1028 r2 G1/G2 check G2)', async () => {
    const gw = signedInOnP1([]) as ReturnType<typeof signedInOnP1> & { pushUnlink?: ReturnType<typeof vi.fn> };
    const unlinks = heldUnlinks(gw);
    act(() => useStore.getState().requestSignOut());
    await vi.waitFor(() => expect(unlinks).toHaveLength(1));
    act(() => useStore.getState().setRole('pmc'));
    await vi.waitFor(() => expect(unlinks).toHaveLength(2));
    await act(async () => { unlinks[0](); });
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBeNull());
    const after = { role: useStore.getState().role, generation: useStore.getState().projectScopeGeneration };
    await act(async () => { unlinks[1](); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect({ role: useStore.getState().role, generation: useStore.getState().projectScopeGeneration }).toEqual(after);
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
  it('a flush that sees the scope move never writes a key it cannot read now, and a key listed when it began loses only what the flush settled (#1037 r1)', async () => {
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

describe('#1028 round 1: Set aside, a stalled online send and drafts behind an unreadable key (WEB-02)', () => {
  const draftKey = `vitan.dailyLogDraft.anon.${P2}`;
  const ids = () => useStore.getState().outbox.map((o) => (o as { idempotencyKey: string }).idempotencyKey);
  /** on P2, offline, with `bad` under `badKey` listed unreadable */
  function onP2With(badKey: string, bad = '{not json') {
    localStorage.setItem(badKey, bad);
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
    useStore.getState()._setGateway(gateway(P2) as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().queueUnreadable?.keys).toEqual([badKey]);
  }

  it('4329769575: a draft held here meets the one another tab stored in the repaired key: both are kept, merged', () => {
    onP2With(draftKey, '{"projectId":');
    useStore.getState().checkIn();
    const held = useStore.getState().dailyLogDraft!;
    expect(held.checkIn?.checkedIn).toBe(true);
    // another tab repairs the key with its own draft of the same log: a crew count, no check-in
    const { checkIn: _c, ...rest } = held;
    const theirs = { ...rest, crewRows: { 0: { trade: 'Mason', count: 4 } } };
    localStorage.setItem(draftKey, JSON.stringify(theirs));
    useStore.getState().setAsideUnreadableQueue();
    expect(useStore.getState().queueUnreadable).toBeNull();
    const merged = useStore.getState().dailyLogDraft!;
    expect(merged.checkIn).toEqual(held.checkIn);
    expect(merged.crewRows).toEqual({ 0: { trade: 'Mason', count: 4 } });
    expect(JSON.parse(localStorage.getItem(draftKey) ?? 'null')).toEqual(merged);
  });

  describe('r1 check G2: a held draft and another tab’s draft of a different log, or crew rows that moved', () => {
    /** on P2 with the draft key unreadable, the log on screen given the id LOG-1, and this tab's draft checked in on it */
    function heldOnLog1() {
      onP2With(draftKey, '{"projectId":');
      useStore.setState((s) => { s.dailyLog = { ...s.dailyLog!, id: 'LOG-1', submitted: false }; });
      useStore.getState().checkIn();
      const held = useStore.getState().dailyLogDraft!;
      expect(held.logId).toBe('LOG-1');
      return held;
    }
    const asideOf = (k: string) => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${k}.`)).map((x) => JSON.parse(localStorage.getItem(x)!));

    it('another tab’s draft of another log is copied aside, never dropped; this log’s draft stays and is stored', () => {
      const held = heldOnLog1();
      const theirs = { projectId: P2, logKey: held.logKey, logId: 'OTHER-LOG', crewRows: { 0: { trade: 'Mason', count: 4 } }, photosAdded: 2 };
      localStorage.setItem(draftKey, JSON.stringify(theirs));
      useStore.getState().setAsideUnreadableQueue();
      expect(useStore.getState().queueUnreadable).toBeNull();
      expect(useStore.getState().dailyLogDraft).toEqual(held);
      expect(JSON.parse(localStorage.getItem(draftKey) ?? 'null')).toEqual(held);
      // the key read again when tapped, so nothing else was copied aside: the one copy is theirs, and the person is told
      expect(asideOf(draftKey)).toEqual([theirs]);
      expect(useStore.getState().toast).toBe(QW.draftKeptAside.en.replace('{date}', held.logKey.slice(held.logKey.indexOf(':') + 1)));
    });

    it('an older release’s draft with no log id takes the empty legacy slot, as the #692 rule keeps it', () => {
      const held = heldOnLog1();
      const theirs = { projectId: P2, logKey: held.logKey, crewRows: { 0: { trade: 'Mason', count: 4 } } };
      localStorage.setItem(draftKey, JSON.stringify(theirs));
      useStore.getState().setAsideUnreadableQueue();
      expect(useStore.getState().dailyLogDraft).toEqual(held);
      expect(useStore.getState().legacyDailyLogDraft).toEqual(theirs);
      expect(JSON.parse(localStorage.getItem(`vitan.dailyLogDraft.legacy.anon.${P2}`) ?? 'null')).toEqual(theirs);
    });

    it('crew rows merge by identity: a row whose trade the log no longer holds there gives way and is kept aside, and photos are added (G-c, G-e)', () => {
      const held = heldOnLog1();
      const trade = useStore.getState().dailyLog!.crew[0].trade;
      useStore.setState({ dailyLogDraft: { ...held, crewRows: { 0: { trade: 'Moved trade', count: 1 } }, photosAdded: 1 } });
      const theirs = { projectId: P2, logKey: held.logKey, logId: 'LOG-1', crewRows: { 0: { trade, count: 4 } }, photosAdded: 2 };
      localStorage.setItem(draftKey, JSON.stringify(theirs));
      useStore.getState().setAsideUnreadableQueue();
      const merged = useStore.getState().dailyLogDraft!;
      expect(merged.checkIn).toEqual(held.checkIn);
      expect(merged.crewRows).toEqual({ 0: { trade, count: 4 } });
      // this tab could not read the key, so its count started at nothing: the two counts are of different photos
      expect(merged.photosAdded).toBe(3);
      // the row that gave way is kept aside, never dropped, and the person is told it was this tab's (#1037 r1 check gap 6)
      expect(asideOf(draftKey)).toEqual([{ projectId: P2, logKey: held.logKey, logId: 'LOG-1', crewRows: { 0: { trade: 'Moved trade', count: 1 } } }]);
      expect(useStore.getState().toast).toBe(QW.ownDraftKeptAside.en.replace('{date}', held.logKey.slice(held.logKey.indexOf(':') + 1)));
    });

    it('G-c: two rows at a position the log on screen has no row for: this tab’s is kept, and the other kept aside', () => {
      const held = heldOnLog1();
      useStore.setState({ dailyLogDraft: { ...held, crewRows: { 9: { trade: 'Carpenter', count: 1 } } } });
      const theirs = { projectId: P2, logKey: held.logKey, logId: 'LOG-1', crewRows: { 9: { trade: 'Mason', count: 4 } } };
      localStorage.setItem(draftKey, JSON.stringify(theirs));
      useStore.getState().setAsideUnreadableQueue();
      expect(useStore.getState().dailyLogDraft!.crewRows).toEqual({ 9: { trade: 'Carpenter', count: 1 } });
      expect(asideOf(draftKey)).toEqual([{ projectId: P2, logKey: held.logKey, logId: 'LOG-1', crewRows: { 9: { trade: 'Mason', count: 4 } } }]);
    });

    it('G-e: when this tab could read the draft key, the two counts are of the same photos: the larger is kept', () => {
      onP2With(key(P2));
      useStore.setState((s) => { s.dailyLog = { ...s.dailyLog!, id: 'LOG-1', submitted: false }; });
      useStore.getState().checkIn();
      const held = useStore.getState().dailyLogDraft!;
      useStore.setState({ dailyLogDraft: { ...held, photosAdded: 3 } });
      localStorage.setItem(draftKey, JSON.stringify({ ...held, photosAdded: 2 }));
      useStore.getState().setAsideUnreadableQueue();
      expect(useStore.getState().dailyLogDraft!.photosAdded).toBe(3);
    });

    it('G-a: an older release’s draft whose write to the empty legacy slot is refused is copied aside instead, never held in memory alone', () => {
      const held = heldOnLog1();
      const legacyKey = `vitan.dailyLogDraft.legacy.anon.${P2}`;
      const theirs = { projectId: P2, logKey: held.logKey, crewRows: { 0: { trade: 'Mason', count: 4 } } };
      localStorage.setItem(draftKey, JSON.stringify(theirs));
      const write = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
        if (k === legacyKey) throw new DOMException('full', 'QuotaExceededError');
        write.call(this, k, v);
      });
      useStore.getState().setAsideUnreadableQueue();
      expect(useStore.getState().legacyDailyLogDraft).toBeNull();
      expect(asideOf(draftKey)).toEqual([theirs]);
      expect(useStore.getState().dailyLogDraft).toEqual(held);
    });

    it('G-b: a draft copied aside in the same tap as the unreadable bytes never takes the name of their copy', () => {
      const held = heldOnLog1();
      const theirs = { projectId: P2, logKey: held.logKey, logId: 'OTHER-LOG', crewRows: { 0: { trade: 'Mason', count: 4 } } };
      const write = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
        write.call(this, k, v);
        // another log's draft is written to the key just after the unreadable bytes are copied, so it reads, and loads
        if (k.startsWith(`vitan.unreadable.${draftKey}.`) && v === '{"projectId":') write.call(this, draftKey, JSON.stringify(theirs));
      });
      useStore.getState().setAsideUnreadableQueue();
      const copies = Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${draftKey}.`)).map((x) => localStorage.getItem(x));
      expect(copies.sort()).toEqual(['{"projectId":', JSON.stringify(theirs)].sort());
    });

    it('a losing draft whose copy aside is refused leaves the key as stored and listed, and this tab’s draft not kept', () => {
      const held = heldOnLog1();
      const theirs = { projectId: P2, logKey: held.logKey, logId: 'OTHER-LOG', crewRows: { 0: { trade: 'Mason', count: 4 } } };
      localStorage.setItem(draftKey, JSON.stringify(theirs));
      const write = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
        if (k.startsWith(`vitan.unreadable.${draftKey}.`) && v.includes('OTHER-LOG')) throw new DOMException('full', 'QuotaExceededError');
        write.call(this, k, v);
      });
      useStore.getState().setAsideUnreadableQueue();
      expect(JSON.parse(localStorage.getItem(draftKey) ?? 'null')).toEqual(theirs);
      // still marked as a key this tab's draft started without reading (#1037 r1 check gap 4)
      expect(useStore.getState().queueUnreadable).toEqual({ keys: [draftKey], failed: true, readable: [draftKey], draftsUnread: [draftKey] });
      expect(useStore.getState().dailyLogDraft).toEqual(held);
      expect(useStore.getState().queueUnkept).toContain('draft:current');
      // the key reads: the strip says it could not be set aside, never that it cannot be read (G-d)
      render(<QueueUnreadable />);
      expect(screen.getByTestId('queue-unreadable').textContent).toContain(QW.notSetAside.en);
      expect(screen.getByTestId('queue-unreadable').textContent).not.toContain(QW.unreadable.en);
    });
  });

  it('4329769562: a draft typed while its key could not be read is not kept: sign-out asks, and counts it', () => {
    onP2With(draftKey, '{"projectId":');
    useStore.getState().checkIn();
    expect(useStore.getState().queueUnkept).toEqual(['draft:current']);
    useStore.getState().requestSignOut();
    expect(useStore.getState().leaveConfirm).toEqual({ action: 'signOut' });
    render(<LeaveUnkept />);
    expect(screen.getByTestId('leave-unkept').textContent).toContain(QW.leaveTitle.en.replace('{n}', '1'));
    // once the key is set aside and the draft stored, it is kept, and nothing is asked
    useStore.getState().cancelLeave();
    useStore.getState().setAsideUnreadableQueue();
    expect(useStore.getState().queueUnkept).toEqual([]);
  });

  it('4329769538: a browser that refuses storage itself: Set aside moves nothing, throws nothing, and says it could not', () => {
    onP2With(key(P2));
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new DOMException('denied', 'SecurityError'); } });
    try {
      expect(() => useStore.getState().setAsideUnreadableQueue()).not.toThrow();
      expect(useStore.getState().queueUnreadable).toEqual({ keys: [key(P2)], failed: true });
    } finally {
      Object.defineProperty(globalThis, 'localStorage', real);
    }
    expect(localStorage.getItem(key(P2))).toBe('{not json');
  });

  it('4329769552: a key another tab rewrites after it was read and copied is not removed, and what it wrote loads', () => {
    onP2With(key(P2));
    const theirs = [{ t: 'startActivity', activityId: 'T-1', idempotencyKey: 'k-t1' }];
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      write.call(this, k, v);
      // the other tab's write lands just after this tab's copy
      if (k.startsWith(`vitan.unreadable.${key(P2)}.`)) write.call(this, key(P2), JSON.stringify(theirs));
    });
    useStore.getState().setAsideUnreadableQueue();
    expect(JSON.parse(localStorage.getItem(key(P2)) ?? 'null')).toEqual(theirs);
    expect(ids()).toEqual(['k-t1']);
  });

  it('4329769552: a key rewritten with other bytes it cannot read either stays listed and is said not to be cleared', () => {
    onP2With(key(P2));
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      write.call(this, k, v);
      if (k.startsWith(`vitan.unreadable.${key(P2)}.`)) write.call(this, key(P2), '{other');
    });
    useStore.getState().setAsideUnreadableQueue();
    expect(localStorage.getItem(key(P2))).toBe('{other');
    expect(useStore.getState().queueUnreadable).toEqual({ keys: [key(P2)], failed: true });
  });

  it('4329769527: an online act no write stored, whose send then fails, is said not to be kept, not only pending', async () => {
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: true, capabilities: ['materials'] as never });
    const none = vi.fn(async () => ({ requirements: [], requisitions: [], purchaseOrders: [], lots: [], issues: [] }));
    const gw = {
      project: P2, listSiteVisits: vi.fn(async () => []),
      reserveStock: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
      materialReadiness: none, materialRequirements: none, materialRequisitions: none, materialPurchaseOrders: none, materialStock: none, materialIssues: none,
    };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    // a write-ahead command: stored before it is sent, and here the store refuses it
    useStore.getState().reserveCandidate('ACT-1', 'LOT-1', 'main', '2');
    await vi.waitFor(() => expect(gw.reserveStock).toHaveBeenCalled());
    await vi.waitFor(() => expect(useStore.getState().toast).toContain(QW.notKept.en));
    expect(useStore.getState().queueUnkept).toHaveLength(1);
  });
});

describe('#1037 round 1: leftovers by identity, unknown acts and drafts that are not this scope’s (WEB-02)', () => {
  const draftKey = `vitan.dailyLogDraft.anon.${P2}`;
  const legacyKey = `vitan.dailyLogDraft.legacy.anon.${P2}`;
  const ids = () => useStore.getState().outbox.map((o) => (o as { idempotencyKey: string }).idempotencyKey);
  const storedIds = (k: string) => (JSON.parse(localStorage.getItem(k) ?? '[]') as { idempotencyKey: string }[]).map((o) => o.idempotencyKey);
  const asideOf = (k: string) => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${k}.`)).map((x) => JSON.parse(localStorage.getItem(x)!));
  const snap = () => ({
    project: { id: P2, name: P2, short: P2, descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  });
  /** on P2, offline, the keys as given */
  function onP2(stored: Record<string, string> = {}, gw: object = gateway(P2)) {
    for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
  }
  /** a send held open: `called` resolves when the gateway is called, and the test settles it with `done` or `fail` */
  function heldSend() {
    let called!: () => void;
    const sent = new Promise<void>((r) => { called = r; });
    const ends: { done: () => void; fail: () => void; refuse: () => void } = { done: () => {}, fail: () => {}, refuse: () => {} };
    const send = vi.fn(() => {
      called();
      return new Promise((resolve, reject) => {
        ends.done = () => resolve(snap());
        ends.fail = () => reject(new Error('network'));
        ends.refuse = () => reject(Object.assign(new Error('refused'), { status: 422 }));
      });
    });
    return { send, sent, ends };
  }
  const quota = () => new DOMException('full', 'QuotaExceededError');

  it('4331862679: a flush whose scope moves after a load put another tab’s act ahead of the one it sends stores what it did not send, never the sent act', async () => {
    const { send, sent, ends } = heldSend();
    onP2({}, { project: P2, startActivity: send, listSiteVisits: vi.fn(async () => []) });
    useStore.getState().startActivity('X');
    const x = ids()[0];
    useStore.setState({ online: true });
    const flushing = useStore.getState().flushOutbox();
    await sent;
    // a load while X is out: another tab stored B-0 ahead of X
    localStorage.setItem(key(P2), JSON.stringify([start('B-0'), { t: 'startActivity', activityId: 'X', idempotencyKey: x }]));
    useStore.setState({ queueScope: null });
    useStore.getState().hydrateOutbox();
    expect(ids()).toEqual(['k-B-0', x]);
    // the person switches project before X is answered; X is then sent
    switchTo(P1);
    ends.done();
    await flushing;
    expect(storedIds(key(P2))).toEqual(['k-B-0']);
  });

  it.each([
    ['another tab repairs the key, then Set aside (PF1)', true, 'sent', ['k-B']],
    ['Set aside alone (PF1b)', false, 'sent', []],
    ['another tab repairs the key, then Set aside, and the send fails', true, 'failed', ['k-B', 'A']],
    ['Set aside alone, and the server refuses the send for good (PT1)', false, 'refused', []],
  ] as const)('4331862679 (gap 1): a key listed when the flush began, then %s and a switch: only the acts the flush settled come off it', async (_label, repair, outcome, expected) => {
    const { send, sent, ends } = heldSend();
    onP2({ [key(P2)]: '{bad' }, { project: P2, startActivity: send, listSiteVisits: vi.fn(async () => []) });
    useStore.getState().startActivity('A');
    const a = ids()[0];
    useStore.setState({ online: true });
    const flushing = useStore.getState().flushOutbox();
    await sent;
    if (repair) localStorage.setItem(key(P2), JSON.stringify([start('B')]));
    useStore.getState().setAsideUnreadableQueue();
    expect(storedIds(key(P2))).toEqual(repair ? ['k-B', a] : [a]);
    switchTo(P1);
    if (outcome === 'sent') ends.done(); else if (outcome === 'refused') ends.refuse(); else ends.fail();
    await flushing;
    expect(storedIds(key(P2))).toEqual(expected.map((k) => (k === 'A' ? a : k)));
  });

  it('re-check hardening: a key listed when the flush began, from which the flush settled nothing, keeps the bytes another tab stored', async () => {
    const { send, sent, ends } = heldSend();
    onP2({ [key(P2)]: '{bad' }, { project: P2, startActivity: send, listSiteVisits: vi.fn(async () => []) });
    useStore.getState().startActivity('A');
    const a = ids()[0];
    useStore.setState({ online: true });
    const flushing = useStore.getState().flushOutbox();
    await sent;
    useStore.getState().setAsideUnreadableQueue();
    switchTo(P1);
    // another tab stores the key in its own layout while the send is out
    const theirs = JSON.stringify([start('B'), { t: 'startActivity', activityId: 'A', idempotencyKey: a }], null, 2);
    localStorage.setItem(key(P2), theirs);
    ends.fail();
    await flushing;
    expect(localStorage.getItem(key(P2))).toBe(theirs);
  });

  it('4331862659: a load of the same scope keeps a day-log draft no write stored, merged with the one stored, and stores it', async () => {
    onP2({});
    // the draft write is refused: the check-in is held only here, and is not kept
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string) {
      if (k === draftKey) throw quota();
    });
    act(() => useStore.getState().checkIn());
    write.mockRestore();
    const held = useStore.getState().dailyLogDraft!;
    expect(held.checkIn?.checkedIn).toBe(true);
    expect(useStore.getState().queueUnkept).toContain('draft:current');
    // another tab stores its own draft of the same log: a crew count, no check-in
    const { checkIn: _c, ...rest } = held;
    const theirs = { ...rest, crewRows: { 0: { trade: 'Mason', count: 4 } } };
    localStorage.setItem(draftKey, JSON.stringify(theirs));
    // a sign-in again on the same project loads the same scope
    useStore.getState().hydrateOutbox();
    const merged = useStore.getState().dailyLogDraft!;
    expect(merged.checkIn).toEqual(held.checkIn);
    expect(merged.crewRows).toEqual({ 0: { trade: 'Mason', count: 4 } });
    expect(JSON.parse(localStorage.getItem(draftKey) ?? 'null')).toEqual(merged);
    expect(useStore.getState().queueUnkept).not.toContain('draft:current');
  });

  it('4331862659: a draft typed while its key could not be read meets the one another tab then stored: on a load of the same scope the photos are added', () => {
    onP2({ [draftKey]: '{"projectId":' });
    const logKey = dailyLogKey(useStore.getState().dailyLog!);
    useStore.setState((s) => { s.dailyLogDraft = { projectId: P2, logKey, photosAdded: 1 } as never; s.queueUnkept = ['draft:current']; });
    localStorage.setItem(draftKey, JSON.stringify({ projectId: P2, logKey, photosAdded: 2 }));
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().dailyLogDraft?.photosAdded).toBe(3);
    expect(JSON.parse(localStorage.getItem(draftKey) ?? 'null')?.photosAdded).toBe(3);
  });

  it.each(['a load of the same scope', 'Set aside'] as const)('PG1 (gap 4): a key listed again only because a copy aside failed was read: after %s the photos are the larger count, never added', (_label) => {
    onP2({});
    const log = useStore.getState().dailyLog!;
    const logKey = dailyLogKey(log);
    // held here, not kept: a crew row another tab's row takes the place of, and three photos
    useStore.setState((s) => { s.dailyLogDraft = { projectId: P2, logKey, crewRows: { 0: { trade: 'Moved trade', count: 1 } }, photosAdded: 3 } as never; s.queueUnkept = ['draft:current']; });
    localStorage.setItem(draftKey, JSON.stringify({ projectId: P2, logKey, crewRows: { 0: { trade: log.crew[0].trade, count: 4 } }, photosAdded: 2 }));
    // a load of the same scope whose copy aside of the row that gave way is refused: the key is listed again, and read
    const write = Storage.prototype.setItem;
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith(`vitan.unreadable.${draftKey}.`)) throw quota();
      write.call(this, k, v);
    });
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().queueUnreadable).toEqual({ keys: [draftKey], failed: true, readable: [draftKey] });
    refuse.mockRestore();
    if (_label === 'Set aside') useStore.getState().setAsideUnreadableQueue();
    else useStore.getState().hydrateOutbox();
    expect(useStore.getState().dailyLogDraft?.photosAdded).toBe(3);
    expect(useStore.getState().queueUnreadable).toBeNull();
  });

  it('PM18 (re-check N3): a Set aside that moves nothing keeps the mark of a draft key this tab could not read: the photos are added once it reads', () => {
    onP2({ [draftKey]: '{"projectId":' });
    const logKey = dailyLogKey(useStore.getState().dailyLog!);
    useStore.setState((s) => { s.dailyLogDraft = { projectId: P2, logKey, photosAdded: 3 } as never; s.queueUnkept = ['draft:current']; });
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw quota(); });
    useStore.getState().setAsideUnreadableQueue();
    refuse.mockRestore();
    expect(useStore.getState().queueUnreadable).toEqual({ keys: [draftKey], failed: true, draftsUnread: [draftKey] });
    localStorage.setItem(draftKey, JSON.stringify({ projectId: P2, logKey, photosAdded: 2 }));
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().dailyLogDraft?.photosAdded).toBe(5);
  });

  it('re-check N3: a draft key listed again because a copy aside failed keeps its own mark and the other draft key’s', () => {
    onP2({ [legacyKey]: '{"projectId":', [draftKey]: '{"projectId":' });
    expect(useStore.getState().queueUnreadable?.draftsUnread).toEqual([draftKey, legacyKey]);
    const log = useStore.getState().dailyLog!;
    const logKey = dailyLogKey(log);
    useStore.setState((s) => { s.dailyLogDraft = { projectId: P2, logKey, crewRows: { 0: { trade: 'Moved trade', count: 1 } } } as never; s.queueUnkept = ['draft:current']; });
    // another tab repairs the day-log key only; this tab's copy aside of the row that gives way is refused
    localStorage.setItem(draftKey, JSON.stringify({ projectId: P2, logKey, crewRows: { 0: { trade: log.crew[0].trade, count: 4 } } }));
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith(`vitan.unreadable.${draftKey}.`)) throw quota();
      write.call(this, k, v);
    });
    // a load of the same scope: the legacy key still cannot be read, and the day-log key is listed again
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().queueUnreadable?.keys).toEqual([legacyKey, draftKey]);
    expect(useStore.getState().queueUnreadable?.draftsUnread).toEqual([legacyKey, draftKey]);
  });

  it('PC1 (gap 6): at a load of the same scope, this tab’s own draft that gives way is said to be this tab’s, in en, hi and gu', () => {
    for (const lang of ['en', 'hi', 'gu'] as const) {
      localStorage.clear();
      onP2({});
      useStore.setState({ lang });
      const logKey = dailyLogKey(useStore.getState().dailyLog!);
      // held here, not kept: a check-in on a log the screen no longer shows
      const mine = { projectId: P2, logKey: 'civil:2025-12-31', logId: 'OLD-LOG', checkIn: { checkedIn: true, checkinTime: '07:00' } };
      useStore.setState((s) => { s.dailyLogDraft = mine as never; s.queueUnkept = ['draft:current']; });
      const theirs = { projectId: P2, logKey, crewRows: { 0: { trade: 'Mason', count: 4 } } };
      localStorage.setItem(draftKey, JSON.stringify(theirs));
      useStore.getState().hydrateOutbox();
      expect(useStore.getState().dailyLogDraft).toEqual(theirs);
      expect(asideOf(draftKey)).toEqual([mine]);
      expect(useStore.getState().toast).toBe(QW.ownDraftKeptAside[lang].replace('{date}', '2025-12-31'));
    }
  });

  it.each([
    ['no storage at all', () => vi.stubGlobal('localStorage', undefined)],
    ['storage refusing every read', () => vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); })],
  ])('4331862659: a load of the same scope with %s keeps the drafts no write stored, still not kept', (_label, fault) => {
    onP2({});
    const logKey = dailyLogKey(useStore.getState().dailyLog!);
    const held = { projectId: P2, logKey, photosAdded: 1 };
    const legacy = { projectId: P2, logKey: 'civil:2026-01-01', photosAdded: 2 };
    useStore.setState((s) => { s.dailyLogDraft = held as never; s.legacyDailyLogDraft = legacy as never; s.queueUnkept = ['draft:current', 'draft:legacy']; });
    fault();
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().dailyLogDraft).toEqual(held);
    expect(useStore.getState().legacyDailyLogDraft).toEqual(legacy);
    expect(useStore.getState().queueUnkept).toEqual(['draft:current', 'draft:legacy']);
  });

  it.each([
    ['the general key', (p: string) => key(p), [start('A-1'), { t: 'futureOperation', idempotencyKey: 'k-f' }]],
    ['the visit lane', (p: string) => lane(p), [end, { t: 'siteVisitFutureAct', visitId: 'v-1', idempotencyKey: 'k-fv' }]],
    ['the general key (an entry with no kind)', (p: string) => key(p), [start('A-1'), { activityId: 'A-2', idempotencyKey: 'k-A-2' }]],
  ])('4331862684: %s, holding an entry this release does not know as an act, is unreadable: listed, never loaded or written', async (_label, keyOf, stored) => {
    const raw = JSON.stringify(stored);
    onP2({ [keyOf(P2)]: raw });
    expect(useStore.getState().queueUnreadable?.keys).toEqual([keyOf(P2)]);
    expect(useStore.getState().outbox).toEqual([]);
    useStore.getState().startActivity('B-1');
    expect(localStorage.getItem(keyOf(P2))).toBe(raw);
  });

  it.each([
    ['a labour act whose coalesceKey a newer release renamed (PS1)', (p: string) => key(p), [start('A-1'), { t: 'recordLabourWork', input: { allocationId: 'A', workedMinutes: 60 }, idempotencyKey: 'k-w', workKey: 'lab:work:A:60' }]],
    ['a commercial act with no coalesceKey', (p: string) => key(p), [start('A-1'), { t: 'setCommercialBudget', input: {}, idempotencyKey: 'k-b' }]],
    ['a materials act with neither key', (p: string) => key(p), [{ t: 'issueStock', input: { lotId: 'L', storeLocation: 'S', activityId: 'A', qty: '1' } }]],
    ['a site visit act under the general key', (p: string) => key(p), [start('A-1'), end]],
    ['an act that is not a site visit act under the visit lane', (p: string) => lane(p), [end, start('A-1')]],
    ['a visit photo’s act under the visit lane', (p: string) => lane(p), [{ t: 'siteVisitAddFile', visitId: 'v-1', scope: 's', idempotencyKey: 'k-vf', by: { name: 'n', role: 'consultant' }, placeName: null, file: { id: 'c-1', mime: 'image/png' } }]],
  ])('gap 2: a key holding %s is unreadable: no act read from storage is dropped on load, and its bytes are never written', (_label, keyOf, stored) => {
    const raw = JSON.stringify(stored);
    onP2({ [keyOf(P2)]: raw });
    expect(useStore.getState().queueUnreadable).toEqual({ keys: [keyOf(P2)], failed: false });
    expect(useStore.getState().outbox).toEqual([]);
    useStore.getState().startActivity('B-1');
    useStore.getState().hydrateOutbox();
    expect(localStorage.getItem(keyOf(P2))).toBe(raw);
  });

  it('4331862684: an entry that is not an object holds no act: it is left out, and the acts beside it load, as on main', () => {
    onP2({ [key(P2)]: JSON.stringify([start('A-1'), null, 42, start('A-2')]) });
    expect(useStore.getState().queueUnreadable).toBeNull();
    expect(ids()).toEqual(['k-A-1', 'k-A-2']);
  });

  it('4331862684: an act this release does not know is never taken as sent: it stays queued', async () => {
    const gw = { project: P2, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => snap()) };
    onP2({}, gw);
    const future = { t: 'futureOperation', idempotencyKey: 'k-f' } as unknown as OutboxOp;
    useStore.setState((s) => { s.outbox = [future]; });
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    expect(ids()).toEqual(['k-f']);
  });

  it('4331862679: an act made during a flush that is the same as one it took is kept: each taken act is removed once', async () => {
    const { send, sent, ends } = heldSend();
    onP2({}, { project: P2, submitInspection: send, listSiteVisits: vi.fn(async () => []) });
    // an act with no key of its own: two of them are the same act by identity
    const submit = { t: 'submitInspection', inspectionId: 'I-1', items: [] } as unknown as OutboxOp;
    useStore.setState((s) => { s.outbox = [submit]; });
    useStore.setState({ online: true });
    const flushing = useStore.getState().flushOutbox();
    await sent;
    useStore.setState((s) => { s.outbox.push(submit); });
    ends.done();
    await flushing;
    expect(useStore.getState().outbox).toEqual([submit]);
  });

  it('gap 2: Set aside on a key holding a known act in a shape this release does not load copies its bytes aside whole, and clears it', () => {
    const raw = JSON.stringify([start('A-1'), { t: 'recordLabourWork', input: {}, idempotencyKey: 'k-w' }]);
    onP2({ [key(P2)]: raw });
    useStore.getState().setAsideUnreadableQueue();
    const aside = Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${key(P2)}.`));
    expect(aside.map((x) => localStorage.getItem(x))).toEqual([raw]);
    expect(useStore.getState().queueUnreadable).toBeNull();
  });

  it.each([
    ['a log with no id', false],
    ['a log with an id (PF4c)', true],
  ])('4331862674: Set aside keeps the legacy draft that fits the open log, and copies aside the held one of another day: %s', async (_label, withId) => {
    onP2({ [legacyKey]: '{"projectId":' });
    expect(useStore.getState().queueUnreadable?.keys).toEqual([legacyKey]);
    // every server log has had an id since U1: then only `canAdoptLegacyDraft` tells which legacy draft fits
    if (withId) useStore.setState((s) => { s.dailyLog = { ...s.dailyLog!, id: 'LOG-1' }; });
    const today = useStore.getState().dailyLog!;
    const todayKey = dailyLogKey(today);
    // held here: an older release's draft of another day; another tab repairs the key with one of today's log
    const other = { projectId: P2, logKey: 'civil:2026-01-01', checkIn: { checkedIn: true, checkinTime: '08:00' } };
    useStore.setState((s) => { s.legacyDailyLogDraft = other as never; s.queueUnkept = ['draft:legacy']; });
    const theirs = { projectId: P2, logKey: todayKey, crewRows: { 0: { trade: 'Mason', count: 4 } } };
    localStorage.setItem(legacyKey, JSON.stringify(theirs));
    useStore.getState().setAsideUnreadableQueue();
    expect(useStore.getState().legacyDailyLogDraft).toEqual(theirs);
    expect(asideOf(legacyKey)).toEqual([other]);
  });

  it.each([['the day-log draft', draftKey], ['the kept-aside draft', legacyKey]])('4331862690: %s key holding another project’s draft is unreadable: listed, never removed or written', async (_label, k) => {
    const raw = JSON.stringify({ projectId: P1, logKey: 'civil:2026-01-01', crewRows: { 0: { trade: 'Mason', count: 4 } } });
    onP2({ [k]: raw });
    expect(useStore.getState().queueUnreadable?.keys).toEqual([k]);
    act(() => useStore.getState().checkIn());
    useStore.setState((s) => { s.legacyDailyLogDraft = null; });
    expect(localStorage.getItem(k)).toBe(raw);
  });
});
