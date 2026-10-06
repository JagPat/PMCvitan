import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, type RenderResult } from '@testing-library/react';
import { useState } from 'react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway } from '@/data/apiGateway';
import { CreateProjectModal } from '@/layout/ProjectSwitcher';

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

const tokenFor = (sub: string) => `header.${btoa(JSON.stringify({ sub }))}.sig`;
/** A fresh page: the in-memory store reset as a reload would, localStorage untouched. */
function freshPage() {
  useStore.setState(getInitialState());
  useStore.setState((st) => {
    st.memberships = [{ projectId: 'legacy', name: 'Legacy Villa', short: 'Legacy', role: 'pmc', orgId: 'org-1', orgName: 'Vitan' }];
    st.sessionUserId = 'u-me';
  });
}

beforeEach(() => {
  globalThis.localStorage?.clear(); // the create hold is mirrored there per user
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

    // tab A's create lands; tab B's "Try again" then finishes that SAME attempt, never a new one
    a.create.resolve({ id: 'p-new', name: 'Tab A', short: 'A' });
    await expect(outA).resolves.toMatchObject({ kind: 'created', projectId: 'p-new' });
    b.calls.createProject.mockImplementationOnce(() => Promise.resolve({ id: 'p-new', name: 'Tab A', short: 'A' }));
    await expect(tabB.getState().retryProjectCreate()).resolves.toMatchObject({ kind: 'created', projectId: 'p-new' });
    expect(b.calls.createProject.mock.calls[0]?.[2]).toBe(a.calls.createProject.mock.calls[0]?.[2]);
    tabB.getState()._setGateway(null);
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
    expect(globalThis.localStorage.getItem('vitan.projectCreateHold.u-a')).toBeNull();
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

  it('the same user signing back in mid-create sees it as unknown, and its own late SUCCESS still lifts the hold (Codex 4189880211)', async () => {
    fakeLocks();
    const { gw, create } = fakeGateway();
    s()._setGateway(gw);
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    const out = s().createProject('org-1', { name: 'A project', short: 'A', stage: 'Planning' });
    await settle();
    act(() => s().completeSignOut());
    // the same user signs back in and opens the dialog before the reply: the mirror reads as unknown
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    s().syncProjectCreateHold();
    expect(s().projectCreateHold?.phase).toBe('unknown');
    // the original reply lands: it is THIS user's attempt, so it settles the hold whatever its phase
    create.resolve({ id: 'p-a', name: 'A project', short: 'A' });
    await out;
    await settle();
    expect(s().projectCreateHold).toBeNull();
    expect(globalThis.localStorage.getItem('vitan.projectCreateHold.u-a')).toBeNull();
  });

  it('an EARLIER session\'s failed check never releases a retry that reserved the attempt since (Codex 4190271480)', async () => {
    fakeLocks();
    const { gw, calls } = fakeGateway();
    const firstProbe = deferred<string[]>();
    calls.serverFeatures.mockImplementationOnce(() => firstProbe.promise); // session 1's /health stalls
    s()._setGateway(gw);
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    const first = s().createProject('org-1', { name: 'A project', short: 'A', stage: 'Planning' });
    await settle(); // reserved under lease 1, waiting on /health
    const lease1 = s().projectCreateHold?.lease;
    act(() => s().completeSignOut());
    // the same user signs back in: the attempt reads as unknown, and "Try again" reserves it under a NEW lease
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    s().syncProjectCreateHold();
    const retry = s().retryProjectCreate();
    await settle();
    expect(calls.createProject).toHaveBeenCalledTimes(1); // the retry's POST is out
    const held = s().projectCreateHold;
    expect(held).toMatchObject({ phase: 'in_flight' });
    expect(held?.lease).not.toBe(lease1);
    // session 1's check now fails: it may release only its OWN lease, which is no longer current
    firstProbe.resolve([]);
    await expect(first).resolves.toMatchObject({ kind: 'refused' });
    expect(s().projectCreateHold).toEqual(held);
    expect(JSON.parse(globalThis.localStorage.getItem('vitan.projectCreateHold.u-a') ?? '{}')).toMatchObject({ phase: 'in_flight', lease: held?.lease });
    // so a new create is still held while the retry is out — no second key
    await expect(s().createProject('org-1', { name: 'B', short: 'B', stage: 'Planning' })).resolves.toMatchObject({ kind: 'unknown' });
    expect(calls.createProject).toHaveBeenCalledTimes(1);
    void retry;
  });

  it('an OLDER lease\'s ambiguous reply never downgrades the current reservation; a CONFIRMED create finishes the attempt under any lease', async () => {
    fakeLocks();
    const first = deferred<Created>();
    const second = deferred<Created>();
    const { gw, calls } = fakeGateway();
    calls.createProject.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    s()._setGateway(gw);
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    const out1 = s().createProject('org-1', { name: 'A project', short: 'A', stage: 'Planning' });
    await settle();
    act(() => s().completeSignOut());
    useStore.setState((st) => { st.sessionUserId = 'u-a'; st.sessionToken = tokenFor('u-a'); });
    s().syncProjectCreateHold();
    const out2 = s().retryProjectCreate();
    await settle();
    const retryHold = s().projectCreateHold;
    expect(retryHold?.phase).toBe('in_flight');
    // the FIRST request's reply is ambiguous: it is not the current lease, so the retry's hold stands
    first.reject(httpError(502));
    await out1;
    expect(s().projectCreateHold).toEqual(retryHold);
    // the retry is confirmed: the attempt is finished
    second.resolve({ id: 'p-a', name: 'A project', short: 'A' });
    await expect(out2).resolves.toMatchObject({ kind: 'created', projectId: 'p-a' });
    expect(s().projectCreateHold).toBeNull();
    expect(globalThis.localStorage.getItem('vitan.projectCreateHold.u-a')).toBeNull();
    expect(calls.createProject.mock.calls[1]?.[2]).toBe(calls.createProject.mock.calls[0]?.[2]); // one key throughout
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
    expect(globalThis.localStorage.getItem('vitan.projectCreateHold.u-a')).toBeNull();
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
});
