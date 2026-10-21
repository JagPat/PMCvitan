import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway } from '@/data/apiGateway';
import { loadSession, saveSession } from '@/lib/sessionPersist';

/**
 * #1051 round 3 (Codex 4340114563, issue #1065). A leave already on its way (a project switch waiting on the server's
 * answer, a sign-out or persona switch in its push unlink) let every other way out the person started go unasked: the
 * strip's Reload, a sign-out, a persona switch, another project switch, a sign-in. Its own question at its end comes too
 * late for those: the page has reloaded, or the session or scope is gone with the update no write stored.
 *
 * One rule now: no leave and no reload lets go of an update not kept unless the person agreed to lose it, whatever leave
 * is on its way. A leave on its way covers only what it was Continued with; an update not kept since (made during its
 * wait, or left out by another tab's write) is asked about by any leave or reload the person starts, as with no leave
 * on its way. A tab closed or reloaded by the browser is asked by the browser (`LeaveUnkept`), as before.
 *
 * Every test here fails at d03f1ed except the two marked as guards, which each fail under their break.
 */

const USER = 'u-eng';
const OTHER = 'u-other';
const P1 = 'p-1';
const P2 = 'p-2';
const P3 = 'p-3';
const tokenOf = (sub: string) => `h.${btoa(JSON.stringify({ sub, exp: 4102444800 }))}.s`;
const token = tokenOf(USER);
const key = `vitan.outbox.${USER}.${P1}`;
const newerAct = { t: 'futureKind', idempotencyKey: 'k-f' };
const s = () => useStore.getState();
const held = () => s().outbox.map((o) => (o as { activityId?: string }).activityId);

/** signed in by token on P1, offline, P1's key holding `stored` */
function signedIn(stored: unknown[], gw: Record<string, unknown> = {}) {
  localStorage.setItem(key, JSON.stringify(stored));
  useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionToken: token, sessionUserId: USER, activeProjectId: P1, online: false });
  saveSession({ token, role: 'engineer', projectId: P1 });
  s()._setGateway({ startActivity: vi.fn(async () => ({})), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}
/** another tab's write of the key, and the storage event the browser gives this tab for it */
function otherTab(value: unknown[]) {
  const text = JSON.stringify(value);
  localStorage.setItem(key, text);
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: text, storageArea: localStorage }));
}
/** the next act this tab queues fails to store */
function nextWriteFails(run: () => void) {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  try { run(); } finally { write.mockRestore(); }
}
const stubReload = () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  return reload;
};
/** a promise and the hand that settles it, so a test waits on the call it holds, never a clock */
const open: Promise<unknown>[] = [];
const ends: (() => void)[] = [];
function holdCall<T>() {
  let settle!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { settle = res; fail = rej; });
  open.push(promise);
  ends.push(() => fail(new Error('ended with the test')));
  let called!: () => void;
  const asked = new Promise<void>((res) => { called = res; });
  return { promise, settle, asked, call: () => { called(); return promise; } };
}
/** resolves when the store reaches `cond`: the signal a test waits on, never a clock */
const until = (cond: () => boolean) => new Promise<void>((done) => {
  if (cond()) { done(); return; }
  const stop = useStore.subscribe(() => { if (cond()) { stop(); done(); } });
});
/** a browser that holds a push link: a sign-out first waits on its unlink */
const pushCapable = (unlink: ReturnType<typeof holdCall<object>>) => {
  vi.stubGlobal('navigator', { ...globalThis.navigator, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: 'e' }) } }) } });
  vi.stubGlobal('PushManager', function PushManager() {} as unknown);
  return { pushUnlink: vi.fn(() => unlink.call()) };
};

afterEach(async () => {
  // every call a test still holds ends, so no leave of one test is still on its way in the next
  for (const end of ends.splice(0)) end();
  await act(async () => { await Promise.allSettled(open.splice(0)); });
  s().completeSignOut();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('#1051 r3 (Codex 4340114563, #1065): a leave on its way never lets another leave or a reload go unasked', () => {
  it('Codex’s case: a newer tab’s write during a project switch leaves this tab’s act out; Reload asks first, and the page stays', async () => {
    const reload = stubReload();
    const answer = holdCall<object>();
    signedIn([], { switchProject: vi.fn(() => answer.call()) });
    s().startActivity('A');
    void s().switchProject(P2);
    await answer.asked;
    // a newer release's tab writes the key without this tab's act
    act(() => otherTab([newerAct]));
    act(() => s().requestReload());
    expect(s().leaveConfirm).toEqual({ action: 'reload' });
    expect(reload).not.toHaveBeenCalled();
    expect(held()).toEqual(['A']);
  });

  it('a key a newer release wrote, and an update made during a project switch whose write failed: Reload asks first', async () => {
    const reload = stubReload();
    const answer = holdCall<object>();
    signedIn([newerAct], { switchProject: vi.fn(() => answer.call()) });
    void s().switchProject(P2);
    await answer.asked;
    s().startActivity('E');
    act(() => s().requestReload());
    expect(s().leaveConfirm).toEqual({ action: 'reload' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('a sign-out started during a project switch asks first when an update made meanwhile was not kept', async () => {
    const answer = holdCall<object>();
    signedIn([], { switchProject: vi.fn(() => answer.call()) });
    void s().switchProject(P2);
    await answer.asked;
    nextWriteFails(() => s().startActivity('E'));
    act(() => s().requestSignOut());
    expect(s().leaveConfirm).toEqual({ action: 'signOut' });
    expect(s().sessionToken).toBe(token);
    expect(loadSession()).not.toBeNull();
    expect(held()).toEqual(['E']);
  });

  it('a persona switch started during a project switch asks first when an update made meanwhile was not kept', async () => {
    const answer = holdCall<object>();
    signedIn([], { switchProject: vi.fn(() => answer.call()) });
    void s().switchProject(P2);
    await answer.asked;
    nextWriteFails(() => s().startActivity('E'));
    act(() => s().setRole('pmc'));
    expect(s().leaveConfirm).toEqual({ action: 'persona', role: 'pmc' });
    expect(s().role).toBe('engineer');
    expect(held()).toEqual(['E']);
  });

  it('another project switch started during a project switch asks at the tap when an update made meanwhile was not kept', async () => {
    const answer = holdCall<object>();
    const switchProject = vi.fn(() => answer.call());
    signedIn([], { switchProject });
    void s().switchProject(P2);
    await answer.asked;
    nextWriteFails(() => s().startActivity('E'));
    let second: unknown;
    act(() => { second = s().switchProject(P3); });
    expect(s().leaveConfirm).toEqual(expect.objectContaining({ action: 'switch', projectId: P3 }));
    expect(switchProject).toHaveBeenCalledTimes(1);
    expect(await second).toBe('asked');
  });

  it('a sign-in as someone else during a project switch asks first when an update made meanwhile was not kept', async () => {
    const answer = holdCall<object>();
    const signIn = holdCall<object>();
    const other = { role: 'engineer', token: tokenOf(OTHER), projectId: P1 };
    signedIn([], { switchProject: vi.fn(() => answer.call()), login: vi.fn(() => signIn.call()) });
    void s().switchProject(P2);
    await answer.asked;
    nextWriteFails(() => s().startActivity('E'));
    act(() => s().login('other@example.com', 'pw'));
    await signIn.asked;
    signIn.settle(other);
    await act(() => until(() => !s().access.sending));
    expect(s().leaveConfirm).toEqual(expect.objectContaining({ action: 'signIn', res: other }));
    expect(s().sessionUserId).toBe(USER);
    expect(held()).toEqual(['E']);
  });

  it('Reload during a sign-out’s push unlink asks first when an update made meanwhile was not kept', async () => {
    const reload = stubReload();
    const unlink = holdCall<object>();
    signedIn([newerAct], pushCapable(unlink));
    act(() => s().requestSignOut());
    await unlink.asked;
    s().startActivity('E');
    act(() => s().requestReload());
    expect(s().leaveConfirm).toEqual({ action: 'reload' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('guard: a leave the person Continued with an update not kept covers it: Reload during its wait asks nothing again', async () => {
    const reload = stubReload();
    const answer = holdCall<object>();
    signedIn([newerAct], { switchProject: vi.fn(() => answer.call()) });
    s().startActivity('E');
    void s().switchProject(P2);
    expect(s().leaveConfirm).toEqual(expect.objectContaining({ action: 'switch' }));
    act(() => s().confirmLeave());
    await answer.asked;
    act(() => s().requestReload());
    expect(s().leaveConfirm).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('guard: and a sign-out during that wait goes on unasked', async () => {
    const answer = holdCall<object>();
    signedIn([newerAct], { switchProject: vi.fn(() => answer.call()) });
    s().startActivity('E');
    void s().switchProject(P2);
    act(() => s().confirmLeave());
    await answer.asked;
    act(() => s().requestSignOut());
    expect(s().leaveConfirm).toBeNull();
    expect(s().sessionToken).toBeNull();
  });
});

/** an update whose write fails, then a project switch the person Continued with it, still waiting on the server */
async function continuedSwitchOver(gwExtra: Record<string, unknown> = {}) {
  const answers: ReturnType<typeof holdCall<object>>[] = [];
  const switchProject = vi.fn(() => { const a = holdCall<object>(); answers.push(a); return a.call(); });
  signedIn([], { switchProject, ...gwExtra });
  nextWriteFails(() => s().startActivity('E'));
  expect(s().queueUnkept).toHaveLength(1);
  void s().switchProject(P2);
  expect(s().leaveConfirm).toEqual(expect.objectContaining({ action: 'switch' }));
  act(() => s().confirmLeave());
  await until(() => answers.length === 1);
  return { answers, switchProject };
}

describe('#1051 r3 check: a leave covered by a Continued one carries its agreement, by identity', () => {
  it('Q1 G3: a second switch the agreed leave covers is not asked again when its answer lands first', async () => {
    const { answers } = await continuedSwitchOver();
    let second: Promise<unknown> = Promise.resolve();
    act(() => { second = s().switchProject(P3) as Promise<unknown>; });
    expect(s().leaveConfirm).toBeNull();
    await until(() => answers.length === 2);
    answers[1].settle({ role: 'engineer', token, projectId: P3 });
    await act(async () => { await second; });
    expect(s().leaveConfirm).toBeNull();
  });
  it('Q2 G3: a push sign-out the agreed switch covers is not asked again when its unlink ends first', async () => {
    const unlink = holdCall<object>();
    await continuedSwitchOver(pushCapable(unlink));
    act(() => s().requestSignOut());
    expect(s().leaveConfirm).toBeNull();
    await unlink.asked;
    unlink.settle({});
    await act(() => until(() => s().sessionToken === null || s().leaveConfirm !== null));
    expect(s().leaveConfirm).toBeNull();
    expect(s().sessionToken).toBeNull();
  });
  it('Q3 G3: a push persona switch the agreed switch covers is not asked again when its unlink ends first', async () => {
    const unlink = holdCall<object>();
    await continuedSwitchOver(pushCapable(unlink));
    act(() => s().setRole('pmc'));
    expect(s().leaveConfirm).toBeNull();
    await unlink.asked;
    unlink.settle({});
    await act(() => until(() => s().role === 'pmc' || s().leaveConfirm !== null));
    expect(s().leaveConfirm).toBeNull();
    expect(s().role).toBe('pmc');
  });
  it('T1 identity: the agreed act is kept since and another, one for one, is not: a sign-out asks', async () => {
    await continuedSwitchOver();
    s().startActivity('G'); // this write lands, storing E with it
    expect(s().queueUnkept).toEqual([]);
    nextWriteFails(() => s().startActivity('F'));
    expect(s().queueUnkept).toHaveLength(1);
    act(() => s().requestSignOut());
    expect(s().leaveConfirm).toEqual({ action: 'signOut' });
    expect(s().sessionToken).toBe(token);
  });
  it('T2 every: the agreed act and a new one are not kept: a sign-out asks', async () => {
    await continuedSwitchOver();
    nextWriteFails(() => s().startActivity('F'));
    expect(s().queueUnkept).toHaveLength(2);
    act(() => s().requestSignOut());
    expect(s().leaveConfirm).toEqual({ action: 'signOut' });
  });
  it('T3 draft: a draft not kept since an agreed persona switch began its unlink: a sign-out asks', async () => {
    const unlink = holdCall<object>();
    signedIn([], pushCapable(unlink));
    nextWriteFails(() => s().startActivity('E'));
    act(() => s().setRole('pmc'));
    expect(s().leaveConfirm).toEqual({ action: 'persona', role: 'pmc' });
    act(() => s().confirmLeave());
    await unlink.asked;
    nextWriteFails(() => s().checkIn());
    expect(s().queueUnkept).toContain('draft:current');
    act(() => s().requestSignOut());
    expect(s().leaveConfirm).toEqual({ action: 'signOut' });
  });
});
