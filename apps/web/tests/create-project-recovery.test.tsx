import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, type RenderResult } from '@testing-library/react';
import { useState } from 'react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway } from '@/data/apiGateway';
import { CreateProjectModal } from '@/layout/ProjectSwitcher';
import { resetLiveCreateSendsForTests } from '@/store/projectCreateHold';

/**
 * Legacy-copy recovery — creating a project from a source whose structure the server refuses to
 * copy (a "Ground Floor" zone holding a "Lobby" room AND a normalized-equal "lobby" element: one
 * name under one parent as two kinds). The server's refusal is intentional and rolls everything
 * back (project-initialization-atomicity covers that on PostgreSQL). These cases pin what the
 * client does with it: the REAL store action and the REAL dialog, mounted by a parent that really
 * unmounts it on close, with every server reply held open until the test releases it.
 */

const s = () => useStore.getState();
const RENAME = 'The structure holds "Lobby" twice under one parent as different kinds — rename one before copying it';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const httpError = (status: number, serverMessage?: string) =>
  Object.assign(new Error(`/orgs/org-1/projects ${status}`), { status, ...(serverMessage ? { serverMessage } : {}) });

type Created = { id: string; name: string; short: string };

/** A gateway whose create (and optionally switch) replies only when the test says so; every other
 *  read the dialog or store makes resolves empty. */
function fakeGateway(opts: { switchFails?: boolean; membershipsAfter?: unknown[]; oldApi?: boolean } = {}) {
  const create = deferred<Created>();
  const base: Record<string, unknown> = {
    createProject: vi.fn(() => create.promise),
    switchProject: vi.fn(() =>
      opts.switchFails
        ? Promise.reject(httpError(500))
        : Promise.resolve({ token: 'JWT-new', role: 'pmc', projectId: 'p-new', name: 'Me' })),
    listMemberships: vi.fn(() => Promise.resolve(opts.membershipsAfter ?? [])),
    // the server advertises create receipts unless a case says it is the previous API
    serverFeatures: vi.fn(() => Promise.resolve(opts.oldApi ? [] : ['orgs.createProject.receipt'])),
  };
  const gw = new Proxy(base, {
    get: (t, k) => {
      if (k === 'then') return undefined; // never mistaken for a thenable
      if (!(k in t)) t[k as string] = vi.fn().mockResolvedValue([]);
      return t[k as string];
    },
  });
  return { gw: gw as unknown as ApiGateway, create, calls: base as Record<string, ReturnType<typeof vi.fn>> };
}

function Host() {
  const [open, setOpen] = useState(true);
  return open ? <CreateProjectModal orgId="org-1" onClose={() => setOpen(false)} /> : <div data-testid="host-closed" />;
}

/** A parent that can REOPEN the dialog as a fresh instance, as the project switcher does. */
function Reopenable() {
  const [open, setOpen] = useState(true);
  return open
    ? <CreateProjectModal orgId="org-1" onClose={() => setOpen(false)} />
    : <button data-testid="reopen" onClick={() => setOpen(true)}>New project</button>;
}

function fill(r: RenderResult) {
  fireEvent.change(r.getByPlaceholderText(/Full name/), { target: { value: 'Residence at Thaltej' } });
  fireEvent.change(r.getByPlaceholderText(/Short name/), { target: { value: 'Thaltej' } });
}

function mount(): RenderResult {
  const r = render(<Host />);
  fireEvent.change(r.getByPlaceholderText(/Full name/), { target: { value: 'Residence at Thaltej' } });
  fireEvent.change(r.getByPlaceholderText(/Short name/), { target: { value: 'Thaltej' } });
  // copy the legacy source's structure
  fireEvent.change(r.getByTestId('np-structure-from'), { target: { value: 'proj:legacy' } });
  return r;
}
// the dialog's primary action, by role (it reads "Creating…" while a create is out)
const createButton = (r: RenderResult) => r.getByRole('button', { name: /^Creat/ }) as HTMLButtonElement;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** The identity's durable record (`null` when there is none). */
const record = (scope: string) => JSON.parse(globalThis.localStorage.getItem(`vitan.projectCreateHold.${scope}`) ?? 'null') as { state?: string } | null;
const tokenFor = (sub: string) => `header.${btoa(JSON.stringify({ sub }))}.sig`;
/** A fresh page: the in-memory store reset as a reload would, localStorage untouched. */
function freshPage() {
  resetLiveCreateSendsForTests(); // a reload: this document's own reservations are gone
  useStore.setState(getInitialState());
  useStore.setState((st) => {
    st.memberships = [{ projectId: 'legacy', name: 'Legacy Villa', short: 'Legacy', role: 'pmc', orgId: 'org-1', orgName: 'Vitan' }];
    st.sessionUserId = 'u-me';
  });
}

beforeEach(() => {
  resetLiveCreateSendsForTests();
  globalThis.localStorage?.clear(); // the create hold is recorded there per identity
  useStore.setState(getInitialState());
  useStore.setState((st) => {
    st.memberships = [{ projectId: 'legacy', name: 'Legacy Villa', short: 'Legacy', role: 'pmc', orgId: 'org-1', orgName: 'Vitan' }];
    st.sessionUserId = 'u-me';
  });
});
afterEach(() => {
  cleanup();
  s()._setGateway(null);
});

describe('create project from a source the server refuses to copy', () => {
  it('a refusal keeps the dialog, every input and the server’s own rename advice — never a generic access line', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();

    fireEvent.click(createButton(r));
    await settle(); // the create is out
    expect(createButton(r).textContent).toBe('Creating…');
    expect(createButton(r).disabled).toBe(true);

    create.reject(httpError(400, RENAME));
    await settle();

    expect(r.queryByTestId('host-closed')).toBeNull(); // still open
    expect(r.getByRole('alert').textContent).toBe(RENAME);
    expect((r.getByPlaceholderText(/Full name/) as HTMLInputElement).value).toBe('Residence at Thaltej');
    expect((r.getByPlaceholderText(/Short name/) as HTMLInputElement).value).toBe('Thaltej');
    expect((r.getByTestId('np-structure-from') as HTMLSelectElement).value).toBe('proj:legacy');
    expect(createButton(r).disabled).toBe(false); // retry is safe: nothing was created
    expect(calls.switchProject).not.toHaveBeenCalled();
    expect(s().toast ?? '').not.toMatch(/check your access/);
  });

  it('a repeat submit while the create is out sends nothing more', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    fireEvent.click(createButton(r));
    fireEvent.click(createButton(r));
    await settle(); // the send follows the cross-tab reservation, a turn later
    expect(calls.createProject).toHaveBeenCalledTimes(1);
    create.reject(httpError(400, RENAME));
    await settle();
  });

  it('closes only on a confirmed create, then opens the new project', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    await settle();
    expect(r.queryByTestId('host-closed')).toBeNull(); // nothing confirmed yet

    create.resolve({ id: 'p-new', name: 'Residence at Thaltej', short: 'Thaltej' });
    await settle();
    expect(r.getByTestId('host-closed')).toBeTruthy();
    expect(calls.switchProject).toHaveBeenCalledWith('p-new');
    expect(calls.createProject).toHaveBeenCalledWith('org-1', expect.objectContaining({ structureFrom: 'legacy' }), expect.any(String)); // the attempt's idempotency key
  });

  it('created but not opened still closes — the project exists, so a retry would duplicate it', async () => {
    const { gw, create, calls } = fakeGateway({ switchFails: true });
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    create.resolve({ id: 'p-new', name: 'Residence at Thaltej', short: 'Thaltej' });
    await settle();
    expect(r.getByTestId('host-closed')).toBeTruthy();
    expect(s().toast).toMatch(/Thaltej, but it could not be opened/);
    expect(calls.createProject).toHaveBeenCalledTimes(1);
  });

  it('an unconfirmed outcome keeps the inputs, refreshes the project list and LOCKS Create — a retry could make it twice', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    useStore.setState((st) => { st.sessionToken = 'header.eyJzdWIiOiJ1LW1lIn0.sig'; });
    const r = mount();
    fireEvent.click(createButton(r));
    create.reject(new TypeError('Failed to fetch')); // no status: the request may or may not have landed
    await settle();
    expect(calls.listMemberships).toHaveBeenCalled(); // the list is refreshed so the user can check it
    expect(r.queryByTestId('host-closed')).toBeNull();
    expect(r.getByRole('alert').textContent).toMatch(/did not confirm/);
    expect((r.getByPlaceholderText(/Short name/) as HTMLInputElement).value).toBe('Thaltej');
    // the create may still commit and carries no idempotency key: no second press from this dialog
    expect(createButton(r).disabled).toBe(true);
    fireEvent.click(createButton(r));
    expect(calls.createProject).toHaveBeenCalledTimes(1);
  });

  it('a same-named project appearing meanwhile is NOT taken as this create — it may be another tab’s or admin’s', async () => {
    const other = { projectId: 'p-other', name: 'Residence at Thaltej', short: 'Thaltej', role: 'pmc', orgId: 'org-1', orgName: 'Vitan' };
    const { gw, create, calls } = fakeGateway({ membershipsAfter: [...s().memberships, other] });
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    create.reject(httpError(502));
    await settle();
    expect(calls.switchProject).not.toHaveBeenCalled(); // never switched into someone else's project
    expect(r.queryByTestId('host-closed')).toBeNull();
    expect(r.getByRole('alert').textContent).toMatch(/did not confirm/);
    expect(createButton(r).disabled).toBe(true);
  });

  it('the unknown-outcome lock OUTLIVES the dialog: Cancel, reopen, and only "Try again" finishes it — under the SAME key (Codex 4184306919, 4185707835)', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = render(<Reopenable />);
    fill(r);
    fireEvent.click(createButton(r));
    create.reject(httpError(502));
    await settle();
    fireEvent.click(r.getByRole('button', { name: 'Cancel' }));
    // a FRESH dialog instance: its own component state starts empty, the session hold does not
    fireEvent.click(r.getByTestId('reopen'));
    fill(r);
    expect(createButton(r).disabled).toBe(true);
    expect(r.getByTestId('np-error').textContent).toMatch(/did not confirm/);
    fireEvent.click(createButton(r));
    await settle();
    expect(calls.createProject).toHaveBeenCalledTimes(1); // no second POST from the reopened dialog
    // the store refuses too, whichever caller asks
    expect((await s().createProject('org-1', { name: 'Again', short: 'Again', stage: 'Planning' })).kind).toBe('unknown');
    expect(calls.createProject).toHaveBeenCalledTimes(1);
    // the only way forward is the attempt itself: "Try again" resends it under ITS key, which the server
    // answers with the first create's project if it committed (here: it did)
    calls.createProject.mockImplementationOnce(() => Promise.resolve({ id: 'p-new', name: 'Residence at Thaltej', short: 'Thaltej' }));
    fireEvent.click(r.getByTestId('np-retry'));
    await settle();
    expect(calls.createProject).toHaveBeenCalledTimes(2);
    const [first, second] = calls.createProject.mock.calls;
    expect(second?.[2]).toBe(first?.[2]); // the same idempotency key
    expect(second?.[1]).toEqual(first?.[1]); // the same request
    expect(typeof first?.[2]).toBe('string');
    expect(s().projectCreateHold).toBeNull();
    expect(r.queryByTestId('np-retry')).toBeNull();
  });

  it('a create dismissed while still OUT locks a reopened dialog until it settles', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = render(<Reopenable />);
    fill(r);
    fireEvent.click(createButton(r));
    await settle(); // the create is out (after the capability check and the reservation)
    fireEvent.click(r.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(r.getByTestId('reopen'));
    fill(r);
    expect(createButton(r).disabled).toBe(true);
    expect(r.queryByTestId('np-retry')).toBeNull(); // nothing to retry while the create is still out
    fireEvent.click(createButton(r));
    await settle();
    expect(calls.createProject).toHaveBeenCalledTimes(1);
    create.reject(httpError(400, RENAME)); // the first create is refused: nothing was made
    await settle();
    expect(s().projectCreateHold).toBeNull();
    expect(createButton(r).disabled).toBe(false);
  });

  it('a 408 is NOT a refusal: the request may still commit, so the outcome is unknown and Create stays locked (Codex 4185009892)', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    create.reject(httpError(408));
    await settle();
    expect(s().projectCreateHold?.phase).toBe('unknown');
    expect(r.getByRole('alert').textContent).toMatch(/did not confirm/);
    expect(createButton(r).disabled).toBe(true);
    fireEvent.click(createButton(r));
    expect(calls.createProject).toHaveBeenCalledTimes(1);
  });

  it('a late reply from an EARLIER session never lifts a later session\'s hold (Codex 4185009904)', async () => {
    const first = deferred<Created>();
    const second = deferred<Created>();
    const { gw, calls } = fakeGateway();
    calls.createProject.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    s()._setGateway(gw);
    // admin A starts a create, then signs out while it is out
    useStore.setState((st) => { st.sessionToken = tokenFor('u-a'); });
    const a = s().createProject('org-1', { name: 'A project', short: 'A', stage: 'Planning' });
    await settle(); // A's create is out
    act(() => s().completeSignOut());
    // admin B signs in and starts their own create
    useStore.setState((st) => { st.sessionUserId = 'u-b'; st.sessionToken = tokenFor('u-b'); });
    const b = s().createProject('org-1', { name: 'B project', short: 'B', stage: 'Planning' });
    await settle();
    expect(s().projectCreateHold?.phase).toBe('in_flight');
    // A's create settles late (a refusal): B's create is still out, so B's hold must stand
    first.reject(httpError(400, 'refused'));
    expect((await a).kind).toBe('stale');
    expect(s().projectCreateHold?.phase).toBe('in_flight');
    expect((await s().createProject('org-1', { name: 'B again', short: 'B2', stage: 'Planning' })).kind).toBe('unknown');
    expect(calls.createProject).toHaveBeenCalledTimes(2); // no third POST while B's is out
    second.reject(httpError(400, 'refused'));
    expect((await b).kind).toBe('refused');
    expect(s().projectCreateHold).toBeNull();
  });

  it('a RELOAD (or another tab) still sees an unconfirmed create: the mirrored hold locks a fresh store\'s dialog', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    create.reject(httpError(502));
    await settle();
    cleanup();
    // a reload: the in-memory store starts empty, localStorage survives
    freshPage();
    s()._setGateway(gw);
    const r2 = mount();
    expect(createButton(r2).disabled).toBe(true);
    expect(r2.getByRole('alert').textContent).toMatch(/did not confirm/);
    fireEvent.click(createButton(r2));
    expect(calls.createProject).toHaveBeenCalledTimes(1);
    // the reloaded page finishes the SAME attempt — its key and request survived in the mirror
    calls.createProject.mockImplementationOnce(() => Promise.resolve({ id: 'p-new', name: 'Residence at Thaltej', short: 'Thaltej' }));
    fireEvent.click(r2.getByTestId('np-retry'));
    await settle();
    const [first, second] = calls.createProject.mock.calls;
    expect(second?.[2]).toBe(first?.[2]);
    expect(second?.[1]).toEqual(first?.[1]);
    // settled everywhere, including the mirror: a later page starts unlocked
    cleanup();
    freshPage();
    const r3 = mount();
    expect(createButton(r3).disabled).toBe(false);
  });

  it('a create still OUT when the page reloaded is unknown afterwards, never settled by the new page', async () => {
    const { gw, calls } = fakeGateway();
    s()._setGateway(gw);
    void s().createProject('org-1', { name: 'Out', short: 'Out', stage: 'Planning' }); // never answers
    await settle(); // it is out when the page reloads
    freshPage();
    s()._setGateway(gw);
    const r = mount();
    expect(createButton(r).disabled).toBe(true);
    expect(r.getByRole('alert').textContent).toMatch(/another tab, or from before this page reloaded/);
    await settle();
    expect(calls.createProject).toHaveBeenCalledTimes(1);
  });

  it('a retry that is DEFINITELY refused clears the hold; one that is unknown again keeps it, with the same key', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    create.reject(httpError(503));
    await settle();
    calls.createProject.mockImplementationOnce(() => Promise.reject(httpError(504)));
    fireEvent.click(r.getByTestId('np-retry'));
    await settle();
    expect(s().projectCreateHold?.phase).toBe('unknown');
    calls.createProject.mockImplementationOnce(() => Promise.reject(httpError(400, RENAME)));
    fireEvent.click(r.getByTestId('np-retry'));
    await settle();
    const keys = calls.createProject.mock.calls.map((c) => c[2]);
    expect(new Set(keys).size).toBe(1); // every send of the attempt carried one key
    expect(s().projectCreateHold).toBeNull();
    expect(r.getByRole('alert').textContent).toContain(RENAME);
    expect(createButton(r).disabled).toBe(false);
  });

  it('signing out ends the hold with the session', async () => {
    const { gw, create } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    create.reject(httpError(502));
    await settle();
    expect(s().projectCreateHold?.phase).toBe('unknown');
    act(() => s().completeSignOut());
    expect(s().projectCreateHold).toBeNull();
  });

  it('Cancel while the create is out: the dialog goes, and a late refusal is told as a toast', async () => {
    const { gw, create } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    await settle(); // the create is out
    fireEvent.click(r.getByRole('button', { name: 'Cancel' }));
    expect(r.getByTestId('host-closed')).toBeTruthy();

    create.reject(httpError(400, RENAME));
    await settle();
    expect(s().toast).toBe(RENAME);
  });

  it('Escape while the create is out: a late success still opens the project it made', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(r.getByTestId('host-closed')).toBeTruthy();

    create.resolve({ id: 'p-new', name: 'Residence at Thaltej', short: 'Thaltej' });
    await settle();
    expect(calls.switchProject).toHaveBeenCalledWith('p-new');
  });

  it('a reply landing after the signed-in user changed is dropped — no toast, no switch', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    await settle(); // the create is out
    act(() => { useStore.setState((st) => { st.sessionUserId = 'u-other'; st.toast = null; }); });

    create.reject(httpError(400, RENAME));
    await settle();
    expect(s().toast).toBeNull();
    expect(r.getByTestId('host-closed')).toBeTruthy(); // the dialog belonged to the previous user
    expect(calls.switchProject).not.toHaveBeenCalled();
  });

  it('a create confirmed while a switch to another project is still pending is announced, not switched to', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    // switchProject's synchronous entry: generation bumped, target pending, active id not yet moved
    act(() => { useStore.setState((st) => { st.projectScopeGeneration += 1; st.pendingProjectId = 'p-b'; st.projectLoadState = 'switching'; }); });

    create.resolve({ id: 'p-new', name: 'Residence at Thaltej', short: 'Thaltej' });
    await settle();
    expect(r.getByTestId('host-closed')).toBeTruthy();
    expect(calls.switchProject).not.toHaveBeenCalled(); // never races the user's own switch
    expect(s().toast).toMatch(/open it from the project switcher/);
  });

  it('a create confirmed after the user moved to another project is announced, not switched to', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    const r = mount();
    fireEvent.click(createButton(r));
    act(() => { useStore.setState((st) => { st.activeProjectId = 'legacy'; }); });

    create.resolve({ id: 'p-new', name: 'Residence at Thaltej', short: 'Thaltej' });
    await settle();
    expect(r.getByTestId('host-closed')).toBeTruthy();
    expect(calls.switchProject).not.toHaveBeenCalled();
    expect(s().toast).toMatch(/open it from the project switcher/);
  });
});

/**
 * Codex 4187151998 — two TABS (two store instances over one localStorage) whose open dialogs submit
 * at nearly the same moment. localStorage has no compare-and-set, so the check, the key and the
 * in-flight record are one reservation under an exclusive Web Lock per user; this LockManager is the
 * browser's, shared by both tabs, with a barrier that holds both requests until both are queued.
 */
describe('cross-tab project create — one reservation at a time', () => {
  const realLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  afterEach(() => {
    if (realLocks) Object.defineProperty(globalThis.navigator, 'locks', realLocks);
    else delete (globalThis.navigator as { locks?: unknown }).locks;
  });

  /** The browser's LockManager for this origin, shared by every tab: exclusive requests per name are
   *  granted FIFO (the first only once the test's barrier opens), shared ones at once, and `query`
   *  reports what is held. */
  function fakeLocks(opts: { barrier?: boolean } = {}) {
    const gate = deferred<void>();
    if (!opts.barrier) gate.resolve();
    const names: string[] = [];
    const held: Array<{ name: string; mode: string }> = [];
    const tails = new Map<string, Promise<unknown>>();
    const hold = async (name: string, mode: string, cb: () => unknown) => {
      const entry = { name, mode };
      held.push(entry);
      try { return await cb(); } finally { held.splice(held.indexOf(entry), 1); }
    };
    const locks = {
      request: (name: string, o: { mode?: string } | undefined, cb: () => unknown) => {
        names.push(name);
        const mode = o?.mode ?? 'exclusive';
        if (mode === 'shared') return hold(name, mode, cb);
        const run = (tails.get(name) ?? gate.promise).then(() => hold(name, mode, cb));
        tails.set(name, run.catch(() => undefined));
        return run;
      },
      query: async () => ({ held: held.map((h) => ({ ...h })), pending: [] }),
    };
    Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
    return { open: () => gate.resolve(), names, held };
  }
  const noLocks = () => Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
  /** Site storage refused, as a browser blocking it does: every read and write throws. */
  const blockStorage = () => {
    for (const m of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, m).mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    }
  };
  afterEach(() => vi.restoreAllMocks());
  /** A second tab: its own store over the same localStorage and LockManager. */
  async function secondTab(session: { token?: string | null; userId: string }) {
    vi.resetModules();
    const { useStore: tab, getInitialState: initial } = await import('@/store/store');
    tab.setState(initial());
    tab.setState((st) => { st.sessionUserId = session.userId; st.sessionToken = session.token ?? null; });
    return tab;
  }

  it('two tabs submitting together send ONE create; the second tab reads the first tab\'s record and is held', async () => {
    const barrier = fakeLocks({ barrier: true });
    const tabA = useStore;
    const tabB = await secondTab({ userId: 'u-me', token: tokenFor('u-a') });
    tabA.setState((st) => { st.sessionUserId = 'u-me'; st.sessionToken = tokenFor('u-a'); });
    const a = fakeGateway();
    const b = fakeGateway();
    tabA.getState()._setGateway(a.gw);
    tabB.getState()._setGateway(b.gw);

    // both submit before either reservation runs — the interleaving where both would read "no hold"
    const outA = tabA.getState().createProject('org-1', { name: 'Tab A', short: 'A', stage: 'Planning' });
    const outB = tabB.getState().createProject('org-1', { name: 'Tab B', short: 'B', stage: 'Planning' });
    await settle(); // both asked the server's features and queued for the reservation; neither is granted
    expect(barrier.names).toEqual(['vitan.projectCreate.u-a', 'vitan.projectCreate.u-a']);
    expect(a.calls.createProject).not.toHaveBeenCalled();
    expect(b.calls.createProject).not.toHaveBeenCalled();

    barrier.open();
    await expect(outB).resolves.toEqual({ kind: 'unknown', message: expect.stringMatching(/another tab/) });
    expect(a.calls.createProject).toHaveBeenCalledTimes(1);
    expect(b.calls.createProject).not.toHaveBeenCalled(); // no second key was ever minted
    expect(tabB.getState().projectCreateHold).toMatchObject({
      phase: 'unknown', attempt: a.calls.createProject.mock.calls[0]?.[2],
    });

    // while tab A's create is still out, tab B's "Try again" finishes that SAME attempt, never a new one
    b.calls.createProject.mockImplementationOnce(() => Promise.resolve({ id: 'p-new', name: 'Tab A', short: 'A' }));
    await expect(tabB.getState().retryProjectCreate()).resolves.toMatchObject({ kind: 'created', projectId: 'p-new' });
    expect(b.calls.createProject.mock.calls[0]?.[2]).toBe(a.calls.createProject.mock.calls[0]?.[2]);
    // tab A's own reply then lands on an attempt already finished — nothing is held anywhere
    a.create.resolve({ id: 'p-new', name: 'Tab A', short: 'A' });
    await expect(outA).resolves.toMatchObject({ kind: 'created', projectId: 'p-new' });
    expect(tabA.getState().projectCreateHold).toBeNull();
    tabB.getState()._setGateway(null);
  });

  it('a hold another tab FINISHED is lifted here too: the open dialog re-reads the cleared record (Codex 4192001251)', async () => {
    fakeLocks();
    useStore.setState((st) => { st.sessionToken = tokenFor('u-a'); });
    const tabA = await secondTab({ userId: 'u-me', token: tokenFor('u-a') });
    const a = fakeGateway();
    tabA.getState()._setGateway(a.gw);
    const outA = tabA.getState().createProject('org-1', { name: 'Tab A', short: 'A', stage: 'Planning' });
    await settle(); // tab A's create is out
    const b = fakeGateway();
    s()._setGateway(b.gw);
    const r = render(<Reopenable />);
    fill(r);
    expect(createButton(r).disabled).toBe(true); // this tab adopted tab A's record as unknown
    expect(r.getByRole('alert').textContent).toMatch(/another tab/);

    // tab A's create is DEFINITELY refused: nothing was made, and tab A clears the record
    a.create.reject(httpError(422, 'A project with that short name already exists'));
    await expect(outA).resolves.toMatchObject({ kind: 'refused' });
    // the browser tells this tab its storage changed: Create is free again without a reload
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'vitan.projectCreateHold.u-a' })); });
    expect(s().projectCreateHold).toBeNull();
    expect(createButton(r).disabled).toBe(false);
    // and a NEW create goes out under a NEW key — tab A's attempt is never resent
    fireEvent.click(createButton(r));
    await settle();
    expect(b.calls.createProject).toHaveBeenCalledTimes(1);
    expect(b.calls.createProject.mock.calls[0]?.[2]).not.toBe(a.calls.createProject.mock.calls[0]?.[2]);
    tabA.getState()._setGateway(null);
  });

  it('a cleared record is seen at the next sync even without a storage event: a reopened dialog and "Try again" both read it', async () => {
    fakeLocks();
    useStore.setState((st) => { st.sessionToken = tokenFor('u-a'); });
    const tabA = await secondTab({ userId: 'u-me', token: tokenFor('u-a') });
    const a = fakeGateway();
    tabA.getState()._setGateway(a.gw);
    const outA = tabA.getState().createProject('org-1', { name: 'Tab A', short: 'A', stage: 'Planning' });
    await settle();
    const b = fakeGateway();
    s()._setGateway(b.gw);
    s().syncProjectCreateHold();
    expect(s().projectCreateHold?.phase).toBe('unknown');
    a.create.reject(httpError(422));
    await outA;
    // "Try again" re-reads the record first: the attempt is gone, so nothing is resent
    await expect(s().retryProjectCreate()).resolves.toEqual({ kind: 'unknown', message: expect.stringMatching(/no unconfirmed/) });
    expect(b.calls.createProject).not.toHaveBeenCalled();
    expect(s().projectCreateHold).toBeNull();
    const r = render(<Reopenable />);
    fill(r);
    expect(createButton(r).disabled).toBe(false);
    tabA.getState()._setGateway(null);
  });

  it('storage that cannot be READ hides the attempt but sends nothing new: the attempt stays in the record', async () => {
    fakeLocks();
    useStore.setState((st) => { st.sessionToken = tokenFor('u-a'); });
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    void s().createProject('org-1', { name: 'Y', short: 'Y', stage: 'Planning' });
    await settle();
    create.reject(httpError(502));
    await settle();
    expect(s().projectCreateHold?.phase).toBe('unknown');
    const spies = (['getItem', 'setItem'] as const).map((m) =>
      vi.spyOn(Storage.prototype, m).mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); }));
    // nothing can be reserved without a durable record, so no second key is minted or sent
    await expect(s().createProject('org-1', { name: 'Z', short: 'Z', stage: 'Planning' })).resolves.toEqual({ kind: 'refused', message: expect.stringMatching(/blocking site storage/) });
    expect(calls.createProject).toHaveBeenCalledTimes(1);
    spies.forEach((spy) => spy.mockRestore());
    // readable again: the same attempt is still there, for "Try again"
    s().syncProjectCreateHold();
    expect(s().projectCreateHold?.phase).toBe('unknown');
  });

  it('a STALLED capability check cannot let another tab create meanwhile: the attempt is reserved first (Codex 4189880202)', async () => {
    fakeLocks();
    const tabA = useStore;
    const tabB = await secondTab({ userId: 'u-me', token: tokenFor('u-a') });
    tabA.setState((st) => { st.sessionUserId = 'u-me'; st.sessionToken = tokenFor('u-a'); });
    const a = fakeGateway();
    const b = fakeGateway();
    const probeA = deferred<string[]>();
    a.calls.serverFeatures.mockImplementationOnce(() => probeA.promise); // tab A's /health stalls
    tabA.getState()._setGateway(a.gw);
    tabB.getState()._setGateway(b.gw);

    const outA = tabA.getState().createProject('org-1', { name: 'Tab A', short: 'A', stage: 'Planning' });
    await settle(); // A has reserved and is waiting on /health
    // tab B submits while A's check is out: A's in-flight record holds it, so B mints no key and sends nothing
    await expect(tabB.getState().createProject('org-1', { name: 'Tab B', short: 'B', stage: 'Planning' }))
      .resolves.toEqual({ kind: 'unknown', message: expect.stringMatching(/another tab/) });
    expect(b.calls.createProject).not.toHaveBeenCalled();
    // A's check answers: A sends its ONE create
    probeA.resolve(['orgs.createProject.receipt']);
    await settle();
    expect(a.calls.createProject).toHaveBeenCalledTimes(1);
    a.create.resolve({ id: 'p-a', name: 'Tab A', short: 'A' });
    await expect(outA).resolves.toMatchObject({ kind: 'created', projectId: 'p-a' });
    tabB.getState()._setGateway(null);
  });

  it('a server without receipts RELEASES a reserved new create, and puts a retried attempt back as unknown', async () => {
    fakeLocks();
    useStore.setState((st) => { st.sessionToken = tokenFor('u-a'); });
    const old = fakeGateway({ oldApi: true });
    s()._setGateway(old.gw);
    await expect(s().createProject('org-1', { name: 'X', short: 'X', stage: 'Planning' }))
      .resolves.toEqual({ kind: 'refused', message: expect.stringMatching(/being updated/) });
    expect(s().projectCreateHold).toBeNull();
    expect(record('u-a')?.state).not.toBe('held'); // released: nothing was sent
    // an unknown attempt, then a retry against a server without receipts: it stays the same unknown attempt
    const fresh = fakeGateway();
    s()._setGateway(fresh.gw);
    void s().createProject('org-1', { name: 'Y', short: 'Y', stage: 'Planning' });
    await settle();
    fresh.create.reject(httpError(502));
    await settle();
    const key = s().projectCreateHold?.attempt;
    s()._setGateway(old.gw);
    await expect(s().retryProjectCreate()).resolves.toEqual({ kind: 'unknown', message: expect.stringMatching(/cannot safely finish/) });
    expect(s().projectCreateHold).toMatchObject({ phase: 'unknown', attempt: key });
    expect(JSON.parse(globalThis.localStorage.getItem('vitan.projectCreateHold.u-a') ?? '{}')).toMatchObject({ phase: 'unknown', attempt: key });
    expect(old.calls.createProject).not.toHaveBeenCalled();
  });

  it('the same user signing back in mid-create still sees THIS page\'s request in flight, and its late SUCCESS lifts the hold (Codex 4189880211)', async () => {
    fakeLocks();
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    const out = s().createProject('org-1', { name: 'A project', short: 'A', stage: 'Planning' });
    await settle();
    act(() => s().completeSignOut());
    // the same user signs back in before the reply: this page's own request is still out, so Create stays
    // held and "Try again" sends nothing while it is
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    s().syncProjectCreateHold();
    expect(s().projectCreateHold?.phase).toBe('in_flight');
    await expect(s().retryProjectCreate()).resolves.toEqual({ kind: 'unknown', message: expect.stringMatching(/already being created/) });
    expect(calls.createProject).toHaveBeenCalledTimes(1);
    // the original reply lands: it is THIS user's attempt, so it settles the hold
    create.resolve({ id: 'p-a', name: 'A project', short: 'A' });
    await out;
    await settle();
    expect(s().projectCreateHold).toBeNull();
    expect(record('u-a')?.state).toBe('settled');
  });

  // Owner-approved correction (direct A→B auth adoption): `login` → `applyAuthResult` adopts another user's
  // token WITHOUT `completeSignOut`. A hold belongs to the identity that took it, so B never sees, retries or
  // overwrites A's attempt, while A's stays recoverable for A.
  const signInAs = async (sub: string, gw: { calls: Record<string, ReturnType<typeof vi.fn>> }) => {
    gw.calls.login = vi.fn(() => Promise.resolve({ role: 'pmc', token: tokenFor(sub), name: sub }));
    s().login(`${sub}@vitan.test`, 'pw');
    await settle();
  };
  const unknownAttempt = async (sub: string, gw: ReturnType<typeof fakeGateway>, name: string) => {
    useStore.setState((st) => { st.sessionUserId = sub; st.sessionToken = tokenFor(sub); });
    void s().createProject('org-1', { name, short: name, stage: 'Planning' });
    await settle();
    gw.create.reject(httpError(502));
    await settle();
    expect(s().projectCreateHold?.phase).toBe('unknown');
    return s().projectCreateHold!.attempt;
  };

  it('A→B sign-in without sign-out: B never retries A\'s attempt as B, and A\'s stays recoverable for A', async () => {
    fakeLocks();
    const gw = fakeGateway();
    s()._setGateway(gw.gw);
    const keyA = await unknownAttempt('u-a', gw, 'A project');
    await signInAs('u-b', gw);
    expect(s().sessionUserId).toBe('u-b');
    s().syncProjectCreateHold();
    expect(s().projectCreateHold).toBeNull(); // B has no attempt of its own
    await expect(s().retryProjectCreate()).resolves.toMatchObject({ kind: 'unknown', message: expect.stringMatching(/no unconfirmed/) });
    expect(gw.calls.createProject).toHaveBeenCalledTimes(1); // nothing of A's was sent as B
    // B's own create is a new attempt under a new key
    gw.calls.createProject.mockImplementationOnce(() => Promise.resolve({ id: 'p-b', name: 'B project', short: 'B' }));
    await expect(s().createProject('org-1', { name: 'B project', short: 'B', stage: 'Planning' })).resolves.toMatchObject({ kind: 'created' });
    expect(gw.calls.createProject.mock.calls[1]?.[2]).not.toBe(keyA);
    // A's attempt is still A's, intact, for A's next sign-in
    expect(JSON.parse(globalThis.localStorage.getItem('vitan.projectCreateHold.u-a') ?? '{}')).toMatchObject({ phase: 'unknown', attempt: keyA });
  });

  it('A→B sign-in where B already has an unconfirmed attempt: B sees and retries ITS OWN, and A\'s record is untouched', async () => {
    fakeLocks();
    const gwB = fakeGateway();
    s()._setGateway(gwB.gw);
    const keyB = await unknownAttempt('u-b', gwB, 'B project');
    const recordB = globalThis.localStorage.getItem('vitan.projectCreateHold.u-b');
    act(() => s().completeSignOut());
    const gwA = fakeGateway();
    s()._setGateway(gwA.gw);
    const keyA = await unknownAttempt('u-a', gwA, 'A project');
    await signInAs('u-b', gwA); // direct adoption, no sign-out
    s().syncProjectCreateHold();
    expect(s().projectCreateHold).toMatchObject({ phase: 'unknown', attempt: keyB });
    expect(globalThis.localStorage.getItem('vitan.projectCreateHold.u-b')).toBe(recordB); // not overwritten by A's
    gwA.calls.createProject.mockImplementationOnce(() => Promise.resolve({ id: 'p-b', name: 'B project', short: 'B' }));
    await expect(s().retryProjectCreate()).resolves.toMatchObject({ kind: 'created', projectId: 'p-b' });
    const retried = gwA.calls.createProject.mock.calls.at(-1);
    expect(retried?.[2]).toBe(keyB);
    expect(retried?.[1]).toMatchObject({ name: 'B project' });
    expect(JSON.parse(globalThis.localStorage.getItem('vitan.projectCreateHold.u-a') ?? '{}')).toMatchObject({ attempt: keyA });
  });

  it('normal sign-out ends the in-memory hold, and the user\'s attempt is still theirs at their next sign-in', async () => {
    fakeLocks();
    const gw = fakeGateway();
    s()._setGateway(gw.gw);
    const keyA = await unknownAttempt('u-a', gw, 'A project');
    act(() => s().completeSignOut());
    expect(s().projectCreateHold).toBeNull();
    await signInAs('u-a', gw);
    s().syncProjectCreateHold();
    expect(s().projectCreateHold).toMatchObject({ phase: 'unknown', attempt: keyA });
  });

  it('the SAME user re-authenticating keeps their hold, and "Try again" finishes it under the same key', async () => {
    fakeLocks();
    const gw = fakeGateway();
    s()._setGateway(gw.gw);
    const keyA = await unknownAttempt('u-a', gw, 'A project');
    await signInAs('u-a', gw); // a fresh token for the same user
    s().syncProjectCreateHold();
    expect(s().projectCreateHold).toMatchObject({ phase: 'unknown', attempt: keyA });
    gw.calls.createProject.mockImplementationOnce(() => Promise.resolve({ id: 'p-a', name: 'A project', short: 'A' }));
    await expect(s().retryProjectCreate()).resolves.toMatchObject({ kind: 'created', projectId: 'p-a' });
    expect(gw.calls.createProject.mock.calls.at(-1)?.[2]).toBe(keyA);
  });

  it('storage BLOCKED: nothing durable could carry the attempt past this page, so nothing is sent (Codex 4187372392, 4187663033)', async () => {
    fakeLocks();
    blockStorage();
    useStore.setState((st) => { st.sessionToken = tokenFor('u-a'); });
    const { gw, calls } = fakeGateway();
    s()._setGateway(gw);
    await expect(s().createProject('org-1', { name: 'X', short: 'X', stage: 'Planning' }))
      .resolves.toEqual({ kind: 'refused', message: expect.stringMatching(/blocking site storage.*Nothing was sent/) });
    expect(calls.createProject).not.toHaveBeenCalled();
    expect(s().projectCreateHold).toBeNull();
  });

  it('NO Web Locks: two tabs submitting together send NOTHING — there is no cross-tab reservation to make (Codex 4187821139)', async () => {
    noLocks();
    const tabA = useStore;
    const tabB = await secondTab({ userId: 'u-me', token: tokenFor('u-a') });
    tabA.setState((st) => { st.sessionUserId = 'u-me'; st.sessionToken = tokenFor('u-a'); });
    const a = fakeGateway();
    const b = fakeGateway();
    tabA.getState()._setGateway(a.gw);
    tabB.getState()._setGateway(b.gw);
    // both read an empty mirror in the same turn — the interleaving a tab-local reservation would lose
    const [outA, outB] = await Promise.all([
      tabA.getState().createProject('org-1', { name: 'Tab A', short: 'A', stage: 'Planning' }),
      tabB.getState().createProject('org-1', { name: 'Tab B', short: 'B', stage: 'Planning' }),
    ]);
    for (const out of [outA, outB]) expect(out).toEqual({ kind: 'refused', message: expect.stringMatching(/lacks Web Locks.*Nothing was sent/) });
    expect(a.calls.createProject).not.toHaveBeenCalled();
    expect(b.calls.createProject).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem('vitan.projectCreateHold.u-a')).toBeNull();
    expect(tabA.getState().projectCreateHold).toBeNull();
    tabB.getState()._setGateway(null);
  });

  it('NO Web Locks: an unknown attempt keeps its hold, and "Try again" sends nothing', async () => {
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    useStore.setState((st) => { st.sessionToken = tokenFor('u-a'); });
    void s().createProject('org-1', { name: 'X', short: 'X', stage: 'Planning' });
    await settle();
    create.reject(httpError(502));
    await settle();
    noLocks();
    await expect(s().retryProjectCreate()).resolves.toEqual({ kind: 'unknown', message: expect.stringMatching(/lacks Web Locks/) });
    expect(calls.createProject).toHaveBeenCalledTimes(1);
    expect(s().projectCreateHold?.phase).toBe('unknown');
  });

  it('an AMBIGUOUS reply landing after sign-out keeps that user\'s attempt: their next sign-in finishes it under the same key (Codex 4187663041)', async () => {
    fakeLocks();
    const { gw, create, calls } = fakeGateway();
    s()._setGateway(gw);
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    const out = s().createProject('org-1', { name: 'A project', short: 'A', stage: 'Planning' });
    await settle();
    act(() => s().completeSignOut());
    create.reject(httpError(502)); // may have committed
    expect((await out).kind).toBe('stale');
    expect(s().projectCreateHold).toBeNull(); // nobody on screen holds it…
    expect(globalThis.localStorage.getItem('vitan.projectCreateHold.u-a')).toContain('"phase":"unknown"'); // …but its user does
    // the same user signs back in: no NEW create, and "Try again" replays the first attempt's key
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    expect((await s().createProject('org-1', { name: 'A again', short: 'A2', stage: 'Planning' })).kind).toBe('unknown');
    expect(calls.createProject).toHaveBeenCalledTimes(1);
    calls.createProject.mockImplementationOnce(() => Promise.resolve({ id: 'p-a', name: 'A project', short: 'A' }));
    await expect(s().retryProjectCreate()).resolves.toMatchObject({ kind: 'created', projectId: 'p-a' });
    expect(calls.createProject.mock.calls[1]?.[2]).toBe(calls.createProject.mock.calls[0]?.[2]);
    expect(calls.createProject.mock.calls[1]?.[1]).toEqual({ name: 'A project', short: 'A', stage: 'Planning' });
  });

  it('a DEFINITE refusal landing after sign-out clears that user\'s attempt — nothing was made', async () => {
    fakeLocks();
    const { gw, create } = fakeGateway();
    s()._setGateway(gw);
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    const out = s().createProject('org-1', { name: 'A project', short: 'A', stage: 'Planning' });
    await settle();
    act(() => s().completeSignOut());
    create.reject(httpError(400, RENAME));
    expect((await out).kind).toBe('stale');
    expect(record('u-a')?.state).toBe('settled'); // nothing was made: no attempt is kept for that user
  });

  it('two passwordless dev identities never share a hold or a key (Codex 4187372380)', async () => {
    fakeLocks();
    // dev auth keeps no token: the session user scopes the hold
    useStore.setState((st) => { st.sessionToken = null; st.sessionUserId = 'u-owner'; });
    const first = fakeGateway();
    s()._setGateway(first.gw);
    void s().createProject('org-1', { name: 'Owner project', short: 'O', stage: 'Planning' });
    await settle();
    first.create.reject(httpError(502));
    await settle();
    expect(s().projectCreateHold?.phase).toBe('unknown');
    expect(globalThis.localStorage.getItem('vitan.projectCreateHold.dev:u-owner')).toContain('"phase":"unknown"');
    // another dev identity, in another tab: it does not see the owner's hold, and its create mints its own key
    const tab = await secondTab({ userId: 'u-other-pmc', token: null });
    const other = fakeGateway();
    tab.getState()._setGateway(other.gw);
    tab.getState().syncProjectCreateHold();
    expect(tab.getState().projectCreateHold).toBeNull();
    await expect(tab.getState().retryProjectCreate()).resolves.toMatchObject({ kind: 'unknown', message: expect.stringMatching(/no unconfirmed/) });
    void tab.getState().createProject('org-1', { name: 'Other project', short: 'P', stage: 'Planning' });
    await settle();
    expect(other.calls.createProject).toHaveBeenCalledTimes(1);
    expect(other.calls.createProject.mock.calls[0]?.[2]).not.toBe(first.calls.createProject.mock.calls[0]?.[2]);
    tab.getState()._setGateway(null);
  });

  it('a server that does not advertise create receipts (a bundle ahead of its API) gets NO create and no keyed retry (Codex 4187372404)', async () => {
    fakeLocks();
    useStore.setState((st) => { st.sessionToken = tokenFor('u-a'); });
    const old = fakeGateway({ oldApi: true });
    s()._setGateway(old.gw);
    await expect(s().createProject('org-1', { name: 'X', short: 'X', stage: 'Planning' }))
      .resolves.toEqual({ kind: 'refused', message: expect.stringMatching(/being updated/) });
    expect(old.calls.createProject).not.toHaveBeenCalled();
    expect(s().projectCreateHold).toBeNull();
    // an unknown create from the new API, then the API rolls back: "Try again" holds, sending nothing
    const fresh = fakeGateway();
    s()._setGateway(fresh.gw);
    void s().createProject('org-1', { name: 'Y', short: 'Y', stage: 'Planning' });
    await settle();
    fresh.create.reject(httpError(502));
    await settle();
    s()._setGateway(old.gw);
    await expect(s().retryProjectCreate()).resolves.toEqual({ kind: 'unknown', message: expect.stringMatching(/cannot safely finish/) });
    expect(old.calls.createProject).not.toHaveBeenCalled();
    expect(s().projectCreateHold?.phase).toBe('unknown');
  });

  it('a sign-in as ANOTHER user while the send waits for the lock sends nothing — never A\'s key under B\'s token', async () => {
    fakeLocks();
    const a = fakeGateway();
    const probe = deferred<string[]>();
    a.calls.serverFeatures.mockImplementationOnce(() => probe.promise);
    s()._setGateway(a.gw);
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    const out = s().createProject('org-1', { name: 'A project', short: 'A', stage: 'Planning' });
    await settle(); // reserved; its capability check is out
    // something else holds A's lock when A's send asks for it
    const busy = deferred<void>();
    void navigator.locks.request('vitan.projectCreate.u-a', { mode: 'exclusive' }, () => busy.promise);
    probe.resolve(['orgs.createProject.receipt']);
    await settle(); // A's send now waits for the lock
    await signInAs('u-b', a);
    busy.resolve();
    await expect(out).resolves.toEqual({ kind: 'stale' });
    expect(a.calls.createProject).not.toHaveBeenCalled();
    expect(record('u-a')?.state).not.toBe('held'); // never sent: released
    expect(s().projectCreateHold).toBeNull();
  });

  it('Codex 4192524377 (RED on ef84407): ANOTHER user adopted while the dialog is open — B is never locked by A\'s create', async () => {
    fakeLocks();
    const a = fakeGateway();
    s()._setGateway(a.gw);
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    const r = render(<Reopenable />);
    fill(r);
    fireEvent.click(createButton(r)); // A's create is out (never answers)
    await settle();
    expect(s().projectCreateHold?.phase).toBe('in_flight');
    await signInAs('u-b', a); // direct adoption, with the dialog open
    // the dialog was A's: it closes, and reopened it is B's — free, with nothing of A's to wait on or retry
    expect(r.getByTestId('reopen')).toBeTruthy();
    expect(s().projectCreateHold).toBeNull();
    fireEvent.click(r.getByTestId('reopen'));
    fill(r);
    expect(createButton(r).disabled).toBe(false);
    expect(r.queryByTestId('np-retry')).toBeNull();
  });

  it('Codex 4192524383 (RED on ef84407): a LIVE in-flight hold is released when another tab CONFIRMED that same attempt', async () => {
    fakeLocks();
    useStore.setState((st) => { st.sessionToken = tokenFor('u-a'); });
    const a = fakeGateway(); // tab A (this store): its POST never answers
    s()._setGateway(a.gw);
    void s().createProject('org-1', { name: 'X', short: 'X', stage: 'Planning' });
    await settle();
    const tabB = await secondTab({ userId: 'u-me', token: tokenFor('u-a') });
    const b = fakeGateway();
    tabB.getState()._setGateway(b.gw);
    b.calls.createProject.mockImplementationOnce(() => Promise.resolve({ id: 'p-x', name: 'X', short: 'X' }));
    tabB.getState().syncProjectCreateHold();
    await expect(tabB.getState().retryProjectCreate()).resolves.toMatchObject({ kind: 'created' });
    s().syncProjectCreateHold(); // what tab A's storage event does
    expect(s().projectCreateHold).toBeNull();
    tabB.getState()._setGateway(null);
  });

  it('Codex 4192524390 (RED on ef84407): a reservation whose probe stalled never sends after another tab\'s retry was DEFINITELY refused', async () => {
    fakeLocks();
    useStore.setState((st) => { st.sessionToken = tokenFor('u-a'); });
    const a = fakeGateway();
    const probe = deferred<string[]>();
    a.calls.serverFeatures.mockImplementationOnce(() => probe.promise);
    s()._setGateway(a.gw);
    const outA = s().createProject('org-1', { name: 'X', short: 'X', stage: 'Planning' });
    await settle(); // reserved; /health stalls
    const tabB = await secondTab({ userId: 'u-me', token: tokenFor('u-a') });
    const b = fakeGateway();
    tabB.getState()._setGateway(b.gw);
    b.calls.createProject.mockImplementationOnce(() => Promise.reject(httpError(422, 'rename one before copying it')));
    tabB.getState().syncProjectCreateHold();
    await expect(tabB.getState().retryProjectCreate()).resolves.toMatchObject({ kind: 'refused' });
    probe.resolve(['orgs.createProject.receipt']);
    await settle();
    expect(a.calls.createProject).not.toHaveBeenCalled();
    void outA;
    tabB.getState()._setGateway(null);
  });
});
