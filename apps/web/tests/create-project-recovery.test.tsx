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
function fakeGateway(opts: { switchFails?: boolean; membershipsAfter?: unknown[] } = {}) {
  const create = deferred<Created>();
  const base: Record<string, unknown> = {
    createProject: vi.fn(() => create.promise),
    switchProject: vi.fn(() =>
      opts.switchFails
        ? Promise.reject(httpError(500))
        : Promise.resolve({ token: 'JWT-new', role: 'pmc', projectId: 'p-new', name: 'Me' })),
    listMemberships: vi.fn(() => Promise.resolve(opts.membershipsAfter ?? [])),
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
    fireEvent.click(r.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(r.getByTestId('reopen'));
    fill(r);
    expect(createButton(r).disabled).toBe(true);
    expect(r.queryByTestId('np-retry')).toBeNull(); // nothing to retry while the create is still out
    fireEvent.click(createButton(r));
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
    act(() => s().completeSignOut());
    // admin B signs in and starts their own create
    useStore.setState((st) => { st.sessionUserId = 'u-b'; st.sessionToken = tokenFor('u-b'); });
    const b = s().createProject('org-1', { name: 'B project', short: 'B', stage: 'Planning' });
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
    freshPage();
    s()._setGateway(gw);
    const r = mount();
    expect(createButton(r).disabled).toBe(true);
    expect(r.getByRole('alert').textContent).toMatch(/another tab, or from before this page reloaded/);
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
