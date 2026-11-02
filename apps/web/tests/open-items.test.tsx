import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { PROOF_PHOTOS_PER_ITEM } from '@vitan/shared';
import type { OpenItem } from '@/data/apiGateway';
import { warmImports } from './warm-imports';

/**
 * #482 proof photos, "Your open items" (RM-w2b) — a contractor's or consultant's Dashboard lists the open inspections
 * they are named to fix (the snapshot's `openItems`), each failed item with "Add proof photo". ONLINE ONLY: a keyed
 * upload of kind `proof`, never an outbox kind; gone once the item holds all its proofs.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAA=';

const ITEMS: OpenItem[] = [
  { inspectionId: 'INSP-30', title: 'Slab check', zone: 'Zone A', nodeId: null, status: 'in-review', failedItems: [
    { itemId: 'it-cover', name: 'Cover', proofCount: 2 },
    { itemId: 'it-full', name: 'Curing', proofCount: PROOF_PHOTOS_PER_ITEM },
  ] },
  { inspectionId: 'INSP-31', title: 'Wall check', zone: 'Zone B', nodeId: null, status: 'issued', failedItems: [] },
  { inspectionId: 'INSP-32', title: 'Drain check', zone: 'Terrace', nodeId: null, status: 'reinspection', failedItems: [
    { itemId: 'it-joints', name: 'Joints', proofCount: 0 },
  ] },
];

const snapshot = (openItems: OpenItem[] | undefined) => ({
  project: { id: 'qa', name: 'QA', short: 'QA', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  ...(openItems ? { openItems } : {}),
});

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/components/OpenItemsBlock'), () => import('@/screens/DashboardScreen'));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The block for `role` on a live, loaded project, under a server whose methods are `gateway`. */
async function openBlock(gateway: Record<string, unknown> = {}, state: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  const snap = vi.fn(() => new Promise(() => {}));
  useStore.setState({
    activeProjectId: 'qa', projectScopeGeneration: 1, projectLoadState: 'ready', role: 'contractor', sessionUserId: 'u-con', short: 'QA',
    lang: 'en', online: true, outbox: [], syncQueue: [], openItems: ITEMS, proofSending: [], ...state,
  } as never);
  useStore.getState()._setGateway({ snapshot: snap, ...gateway } as never);
  const { OpenItemsBlock } = await import('@/components/OpenItemsBlock');
  const view = render(<OpenItemsBlock />);
  return { useStore, view, snap };
}

/** choose `dataUrl` as the photo for item `itemId` through its button, as a person does */
const choose = (view: ReturnType<typeof render>, itemId: string, dataUrl = PNG) => {
  act(() => { fireEvent.click(view.getByTestId(`open-proof-${itemId}-add`)); });
  const [head, b64] = dataUrl.split(',') as [string, string];
  const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'proof.png', { type: head.slice(5, head.indexOf(';')) });
  act(() => { fireEvent.change(view.getByTestId('open-items-file'), { target: { files: [file] } }); });
};

/** an upload that waits for the test to answer it */
function uploads() {
  const calls: Array<{ input: Record<string, unknown>; answer: { resolve: (v: unknown) => void; reject: (e: unknown) => void } }> = [];
  const waiting: Array<{ n: number; done: () => void }> = [];
  const fn = vi.fn((input: Record<string, unknown>) => new Promise((resolve, reject) => {
    calls.push({ input, answer: { resolve, reject } });
    for (const w of waiting.filter((x) => calls.length >= x.n)) { waiting.splice(waiting.indexOf(w), 1); w.done(); }
  }));
  const called = (n = 1) => new Promise<void>((done) => { if (calls.length >= n) done(); else waiting.push({ n, done }); });
  return { fn, calls, called };
}
const refused = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('"Your open items" on a contractor\'s or consultant\'s Dashboard (#482 RM-w2b)', () => {
  it('lists each open inspection by id with where it stands, and each failed item with its proof count', async () => {
    const { view } = await openBlock();
    expect(view.getByTestId('open-items').textContent).toContain('Your open items');
    expect([...view.container.querySelectorAll('[data-testid^="open-item-INSP-"][data-testid$="-status"]')].map((n) => n.getAttribute('data-testid')))
      .toEqual(['open-item-INSP-30-status', 'open-item-INSP-31-status', 'open-item-INSP-32-status']);
    expect(view.getByTestId('open-item-INSP-30-status').textContent).toBe('Waiting on the PMC');
    expect(view.getByTestId('open-item-INSP-31-status').textContent).toBe('Waiting on the engineer');
    expect(view.getByTestId('open-item-INSP-32-status').textContent).toBe('Sent back for re-inspection');
    expect(view.getByTestId('open-item-INSP-31').textContent).toContain('No failed items yet.');
    expect(view.getByTestId('open-proof-it-cover-count').textContent).toBe(`2 of ${PROOF_PHOTOS_PER_ITEM} proof photos`);
    expect(view.getByTestId('open-proof-it-cover-add').textContent).toContain('Add proof photo');
  });

  it(`an item holding ${PROOF_PHOTOS_PER_ITEM} proofs offers no "Add proof photo"`, async () => {
    const { view } = await openBlock();
    expect(view.queryByTestId('open-proof-it-full-add')).toBeNull();
    expect(view.getByTestId('open-proof-it-full-full').textContent).toBe('This item already has all its proof photos.');
  });

  it('with nothing open it says so; a consultant sees the block too', async () => {
    const { view } = await openBlock({}, { openItems: [], role: 'consultant' });
    expect(view.getByTestId('open-items-none').textContent).toBe('Nothing open for you.');
  });

  it('the PMC, the engineer and the client see no block, and nor does anyone before the project has loaded', async () => {
    for (const role of ['pmc', 'engineer', 'client']) {
      const { view } = await openBlock({}, { role });
      expect(view.queryByTestId('open-items')).toBeNull();
      cleanup();
    }
    const { view } = await openBlock({}, { projectLoadState: 'loading' });
    expect(view.queryByTestId('open-items')).toBeNull();
  });

  it('a chosen photo goes up as a proof of that item, under its own key, then the project is read again', async () => {
    const up = uploads();
    const { useStore, view, snap } = await openBlock({ uploadMedia: up.fn });
    choose(view, 'it-joints');
    await up.called();
    expect(up.calls[0]!.input).toEqual({ kind: 'proof', mime: 'image/png', data: PNG.split(',')[1], inspectionId: 'INSP-32', inspectionItemId: 'it-joints', clientKey: expect.any(String) });
    // while it is on its way the button says so and a second tap sends nothing
    expect(view.getByTestId('open-proof-it-joints-add').hasAttribute('disabled')).toBe(true);
    expect(view.getByTestId('open-proof-it-joints-add').textContent).toContain('Sending…');
    expect(await useStore.getState().addProofPhoto('INSP-32', 'it-joints', PNG)).toBe(false);
    expect(up.fn).toHaveBeenCalledTimes(1);
    const before = snap.mock.calls.length;
    await act(async () => { up.calls[0]!.answer.resolve({ id: 'm1', url: '/media/m1' }); });
    await waitFor(() => expect(useStore.getState().toast).toBe('Proof photo added.'));
    expect(snap.mock.calls.length).toBeGreaterThan(before);
    expect(useStore.getState().proofSending).toEqual([]);
  });

  it('offline the button is disabled, one line says why, and nothing is sent', async () => {
    const up = uploads();
    const { useStore, view } = await openBlock({ uploadMedia: up.fn }, { online: false });
    expect(view.getByTestId('open-proof-it-joints-add').hasAttribute('disabled')).toBe(true);
    expect(view.getByTestId('open-items-offline').textContent).toBe('Adding a proof photo needs a connection.');
    expect(await useStore.getState().addProofPhoto('INSP-32', 'it-joints', PNG)).toBe(false);
    expect(useStore.getState().toast).toBe('Adding a proof photo needs a connection.');
    expect(up.fn).not.toHaveBeenCalled();
  });

  it('a 409 (the item is full, or no longer failed) says so, is not retried, and reads the project again', async () => {
    const up = uploads();
    const { useStore, view, snap } = await openBlock({ uploadMedia: up.fn });
    choose(view, 'it-cover');
    await up.called();
    const before = snap.mock.calls.length;
    await act(async () => { up.calls[0]!.answer.reject(refused(409)); });
    await waitFor(() => expect(useStore.getState().toast).toBe('This item already has all its proof photos.'));
    expect(snap.mock.calls.length).toBeGreaterThan(before);
    expect(up.fn).toHaveBeenCalledTimes(1);
  });

  it('a lost answer keeps the key: the same photo sent again replays it; another photo, or one after an answer, is a new key', async () => {
    const up = uploads();
    const { useStore } = await openBlock({ uploadMedia: up.fn });
    const first = useStore.getState().addProofPhoto('INSP-32', 'it-joints', PNG);
    await up.called(1);
    up.calls[0]!.answer.reject(new TypeError('Failed to fetch'));
    expect(await first).toBe(false);
    expect(useStore.getState().toast).toBe('Could not add the proof photo. Try again.');
    const again = useStore.getState().addProofPhoto('INSP-32', 'it-joints', PNG);
    await up.called(2);
    expect(up.calls[1]!.input.clientKey).toBe(up.calls[0]!.input.clientKey);
    up.calls[1]!.answer.reject(new TypeError('Failed to fetch'));
    await again;
    const other = useStore.getState().addProofPhoto('INSP-32', 'it-joints', PNG2);
    await up.called(3);
    expect(up.calls[2]!.input.clientKey).not.toBe(up.calls[0]!.input.clientKey);
    up.calls[2]!.answer.resolve({ id: 'm2', url: '/media/m2' });
    await other;
    const after = useStore.getState().addProofPhoto('INSP-32', 'it-joints', PNG);
    await up.called(4);
    expect(up.calls[3]!.input.clientKey).not.toBe(up.calls[0]!.input.clientKey);
    up.calls[3]!.answer.resolve({ id: 'm3', url: '/media/m3' });
    await after;
  });

  it('a photo chosen before a project switch is never sent, and an answer after the switch says nothing', async () => {
    const up = uploads();
    const { useStore } = await openBlock({ uploadMedia: up.fn });
    const { projectScopeOf } = await import('@/store/projectScope');
    const pickedIn = projectScopeOf(useStore.getState());
    useStore.setState({ projectScopeGeneration: 2 } as never);
    expect(await useStore.getState().addProofPhoto('INSP-32', 'it-joints', PNG, pickedIn)).toBe(false);
    expect(up.fn).not.toHaveBeenCalled();
    // sent in this scope, answered after the next switch: no line, no read
    const sent = useStore.getState().addProofPhoto('INSP-32', 'it-joints', PNG);
    await up.called();
    useStore.setState({ projectScopeGeneration: 3, toast: null } as never);
    up.calls[0]!.answer.resolve({ id: 'm1', url: '/media/m1' });
    expect(await sent).toBe(false);
    expect(useStore.getState().toast).toBeNull();
  });

  it('the snapshot\'s open items are taken whole, and a server without the key reads as none', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    useStore.setState({ activeProjectId: 'qa', projectScopeGeneration: 1, role: 'contractor', sessionUserId: 'u-con', online: true } as never);
    const snapshotFn = vi.fn().mockResolvedValueOnce(snapshot(ITEMS)).mockResolvedValueOnce(snapshot(undefined));
    useStore.getState()._setGateway({ snapshot: snapshotFn } as never);
    await act(async () => { useStore.getState().requestFreshSnapshot(); });
    await waitFor(() => expect(useStore.getState().openItems.map((i) => i.inspectionId)).toEqual(['INSP-30', 'INSP-31', 'INSP-32']));
    await act(async () => { useStore.getState().requestFreshSnapshot(); });
    await waitFor(() => expect(useStore.getState().openItems).toEqual([]));
  });

  it('sits on the Dashboard for a contractor, and not for the PMC', async () => {
    for (const [role, shown] of [['contractor', true], ['pmc', false]] as const) {
      vi.stubEnv('VITE_API_URL', 'http://api.test');
      vi.resetModules();
      const { useStore, getInitialState } = await import('@/store/store');
      const scope = await import('@/store/projectScope');
      useStore.setState(getInitialState());
      useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'qa', projectScopeGeneration: 1, projectLoadState: 'ready', name: 'QA', short: 'QA', portfolio: [], role, lang: 'en', dailyLog: null, openItems: ITEMS } as never);
      const { DashboardScreen } = await import('@/screens/DashboardScreen');
      const view = render(<DashboardScreen />);
      expect(view.queryByTestId('open-items') !== null, role).toBe(shown);
      cleanup();
    }
  });

  it('reads in Hindi and Gujarati: no English but the project\'s own names', async () => {
    for (const lang of ['hi', 'gu'] as const) {
      const { view } = await openBlock({}, { lang });
      const text = view.getByTestId('open-items').textContent ?? '';
      const withoutData = ITEMS.reduce((t, i) => [i.title, i.zone, ...i.failedItems.map((it) => it.name)].reduce((u, w) => u.split(w).join(''), t), text);
      // "PMC" is the role's name in every language (as `dashboardText.waitingOn` writes it)
      expect(withoutData.split('PMC').join(''), `${lang}: ${withoutData}`).not.toMatch(/[A-Za-z]{2,}/);
      cleanup();
    }
  });
});
