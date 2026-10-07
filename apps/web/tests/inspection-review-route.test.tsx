import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Checklist } from '@vitan/shared';

/**
 * Live bug 1b (Codex 4203960945, 4204448859, 4205610125) — `/review/<id>` and `/site/checklist/<id>`
 * each name ONE inspection. While the inspections are still loading (or failed, or a command's reconcile
 * is owed) and that inspection is not among the retained ones, the screen shows the load boundary: never
 * a retained, unrelated review with live approve/reject, nor another checklist, standing in for it.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function mount(state: Record<string, unknown>) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ role: 'pmc', screen: 'inspect-review', ...state });
  const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
  return render(<InspectionReviewScreen />);
}

describe('Inspection Review — a named inspection on an unsettled read', () => {
  it('shows "Loading inspections…", not the retained review, while the read is in flight', async () => {
    const view = await mount({ routeItem: 'INSP-404', projectLoadState: 'loading' });
    expect(view.getByTestId('inspections-loading')).toBeTruthy();
    expect(view.queryByText('Waterproofing Ponding Test')).toBeNull();
  });

  it('shows the unavailable boundary, not the retained review, when the read failed', async () => {
    const view = await mount({ routeItem: 'INSP-404', projectLoadState: 'error' });
    expect(view.getByTestId('inspections-unavailable')).toBeTruthy();
    expect(view.queryByText('Waterproofing Ponding Test')).toBeNull();
  });

  it('a retained review that IS the named one is still shown while the read refreshes', async () => {
    const view = await mount({ routeItem: 'INSP-21', projectLoadState: 'loading' });
    expect(view.getByText('Waterproofing Ponding Test')).toBeTruthy();
  });
});

describe('Inspection Review — a committed command still reconciling (Codex 4204448859)', () => {
  it('a named inspection absent from the retained slice shows "Loading inspections…", not the not-found state', async () => {
    const view = await mount({ routeItem: 'INSP-404', projectLoadState: 'ready', commandReconcilePending: true, commandReconcileOwed: { decisions: false, dailyLog: false, drawings: false, inspections: true, activities: false } });
    expect(view.getByTestId('inspections-loading')).toBeTruthy();
    expect(view.queryByTestId('item-not-found')).toBeNull();
  });
});

describe('Inspection Review — a routed review is shown only once it is the active one (Codex 4208284788)', () => {
  it('while the selection still names another review, nothing actionable stands under the routed URL', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const realSet = useStore.getState().setActiveReview;
    // hold the selection on INSP-21 so the transitional render can be seen
    useStore.setState({ setActiveReview: () => {} });
    const first = useStore.getState().reviews[0];
    const second = { ...structuredClone(first), id: 'INSP-40', title: 'Slab Pour Check', decided: false };
    const view = await mount({ reviews: [first, second], routeItem: 'INSP-40', activeReviewId: first.id });
    expect(view.getByTestId('inspections-opening').textContent).toContain('INSP-40');
    expect(view.queryByText('Waterproofing Ponding Test')).toBeNull();
    expect(view.queryByRole('button', { name: /approve/i })).toBeNull();
    // the selection follows the route: the routed review is shown
    act(() => { useStore.setState({ setActiveReview: realSet }); useStore.getState().setActiveReview('INSP-40'); });
    expect(view.queryByTestId('inspections-opening')).toBeNull();
    expect(view.getAllByText('Slab Pour Check').length).toBeGreaterThan(0);
  });
});

describe('Inspection Review — a decided routed review releases its route once the decision lands (Codex 4209321867, 4209988812)', () => {
  it('Approve keeps the URL while the review is still queued; when the decided review leaves the queue, the URL returns to it — never "not found"', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const first = useStore.getState().reviews[0];
    const view = await mount({ routeItem: first.id, activeReviewId: first.id });
    fireEvent.click(view.getByRole('button', { name: /Approve Inspection/ }));
    // the decision is recorded; the review is still in the queue, so the route still names it
    expect(useStore.getState().routeItem).toBe(first.id);
    // the server's queue holds undecided reviews only: the decided one leaves it
    act(() => { useStore.setState({ reviews: useStore.getState().reviews.filter((r) => r.id !== first.id) }); });
    expect(useStore.getState().routeItem).toBeNull();
    expect(view.queryByTestId('item-not-found')).toBeNull();
  });

  it('a refused decision keeps the route: a reload still opens the linked review, not the queue\'s default', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    // a review that is NOT the queue's default, with nothing rejected: Send Re-inspection is refused
    const linked = useStore.getState().reviews[1] ?? useStore.getState().reviews[0];
    const reviews = useStore.getState().reviews.map((r) => (r.id === linked.id ? { ...r, items: r.items.map((it) => ({ ...it, rejected: false, result: 'PASS' as const })) } : r));
    const view = await mount({ routeItem: linked.id, activeReviewId: linked.id, reviews });
    fireEvent.click(view.getByTestId('send-reinspection'));
    expect(useStore.getState().toast).toMatch(/No items rejected/);
    expect(useStore.getState().routeItem).toBe(linked.id);
    // a reload re-enters the same URL: the linked review is opened again
    cleanup();
    const reloaded = await mount({ routeItem: linked.id, reviews });
    expect(useStore.getState().activeReviewId).toBe(linked.id);
    expect(reloaded.queryByTestId('item-not-found')).toBeNull();
  });
});

describe('Inspection Review — a route naming an outstanding checklist (Codex 4208735406)', () => {
  it('shows that checklist, and none of the active review\'s actions', async () => {
    Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout; the focused checklist scrolls itself into view
    const view = await mount({ routeItem: 'INSP-22' });
    expect(view.getByTestId('routed-checklist')).toBeTruthy();
    expect(view.getByTestId('outstanding-checklist-INSP-22').getAttribute('aria-current')).toBe('true');
    // the active review (INSP-21) and its live actions are not under the checklist's URL
    expect(view.queryByText('Waterproofing Ponding Test')).toBeNull();
    expect(view.queryByRole('button', { name: /approve/i })).toBeNull();
    fireEvent.click(view.getByTestId('routed-checklist-show-reviews'));
    expect(view.getByText('Waterproofing Ponding Test')).toBeTruthy();
  });
});

describe('Inspection Review — the module-owned read (Codex 4205058538)', () => {
  it('a reconcile still owed unsettles a READY module slice: loading, never not-found', async () => {
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    const view = await mount({ routeItem: 'INSP-404', inspectionsLoad: 'ready', commandReconcilePending: true, commandReconcileOwed: { decisions: false, dailyLog: false, drawings: false, inspections: true, activities: false } });
    expect(view.getByTestId('inspections-loading')).toBeTruthy();
    expect(view.queryByTestId('item-not-found')).toBeNull();
  });

  it('settled, the same absent inspection is reported missing, alone', async () => {
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    const view = await mount({ routeItem: 'INSP-404', inspectionsLoad: 'ready' });
    expect(view.getByTestId('item-not-found').textContent).toContain('INSP-404');
    expect(view.queryByText('Waterproofing Ponding Test')).toBeNull();
  });
});

const fieldChecklist = (id: string, title: string): Checklist => ({
  id, title, zone: 'Terrace', date: 'Today', submitted: false,
  items: [{ id: `${id}-1`, name: 'Slope', state: null, photos: 0, note: '' }],
});

async function mountField(state: Record<string, unknown>) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  const a = fieldChecklist('INSP-50', 'Slab Check');
  const b = fieldChecklist('INSP-51', 'Drain Slope Check');
  useStore.setState({ role: 'engineer', screen: 'engineer-check', openChecklists: [a, b], checklist: structuredClone(a), selectedChecklistId: 'INSP-50', ...state });
  const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
  return { useStore, view: render(<EngineerChecklistScreen />) };
}

describe("the engineer's field checklist names ONE checklist (Codex 4205610125)", () => {
  it('a link to an outstanding checklist moves it into the edit slot', async () => {
    const { useStore, view } = await mountField({ routeItem: 'INSP-51' });
    expect(useStore.getState().checklist?.id).toBe('INSP-51');
    expect(view.getByTestId('checklist-title').textContent).toBe('Drain Slope Check');
  });

  it('a link to a checklist the engineer does not hold says so, alone, once settled', async () => {
    const { useStore, view } = await mountField({ routeItem: 'INSP-404' });
    expect(view.getByTestId('item-not-found').textContent).toContain('INSP-404');
    expect(view.queryByTestId('checklist-title')).toBeNull();
    fireEvent.click(view.getByTestId('item-not-found-show-all'));
    expect(useStore.getState().routeItem).toBeNull();
  });

  it('on an unsettled read, an absent checklist shows the load boundary, never another checklist', async () => {
    const { view } = await mountField({ routeItem: 'INSP-404', projectLoadState: 'loading' });
    expect(view.queryByTestId('item-not-found')).toBeNull();
    expect(view.queryByTestId('checklist-title')).toBeNull();
    expect(view.getByText('Loading checklist…')).toBeTruthy();
  });

  it('a picker tap writes the URL only when the switch happens', async () => {
    const { useStore, view } = await mountField({});
    fireEvent.click(view.getByTestId('checklist-tab-INSP-51'));
    expect(useStore.getState().routeItem).toBe('INSP-51');
    // an online submit in flight refuses the switch: the URL must not name a checklist the slot does not hold
    act(() => { useStore.setState({ submission: { ...useStore.getState().submission, status: 'submitting', generation: useStore.getState().projectScopeGeneration } }); });
    fireEvent.click(view.getByTestId('checklist-tab-INSP-50'));
    expect(useStore.getState().checklist?.id).toBe('INSP-51');
    expect(useStore.getState().routeItem).toBe('INSP-51');
  });

  it('a linked checklist that is then submitted releases the URL instead of reporting it missing', async () => {
    const { useStore, view } = await mountField({ routeItem: 'INSP-51' });
    expect(useStore.getState().checklist?.id).toBe('INSP-51');
    // the submit lands: INSP-51 leaves the outstanding set and the slot moves on
    const rest = useStore.getState().openChecklists.filter((c) => c.id !== 'INSP-51');
    act(() => { useStore.setState({ openChecklists: rest, checklist: structuredClone(rest[0]), selectedChecklistId: rest[0].id }); });
    expect(useStore.getState().routeItem).toBeNull();
    expect(view.queryByTestId('item-not-found')).toBeNull();
  });

  it('Codex 4207530085 — while a guarded switch is refused, the slot\'s checklist is not shown under the named URL', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const { useStore: store, view } = await mountField({
      routeItem: 'INSP-51',
      submission: { inspectionId: 'INSP-50', generation: getInitialState().projectScopeGeneration, status: 'submitting', attempt: 1 },
    });
    // the switch was refused: INSP-50 stays in the slot, and is not presented as INSP-51
    expect(store.getState().checklist?.id).toBe('INSP-50');
    expect(view.queryByTestId('checklist-title')).toBeNull();
    expect(view.getByText('Opening Drain Slope Check…')).toBeTruthy();
    // the submit settles: the switch completes
    act(() => { store.setState({ submission: { ...store.getState().submission, status: 'idle' } }); });
    expect(store.getState().checklist?.id).toBe('INSP-51');
    expect(view.getByTestId('checklist-title').textContent).toBe('Drain Slope Check');
  });

  it('Codex 4207530091 — a released link does not pre-release a later link to the same id', async () => {
    const { useStore, view } = await mountField({ routeItem: 'INSP-51' });
    const rest = useStore.getState().openChecklists.filter((c) => c.id !== 'INSP-51');
    act(() => { useStore.setState({ openChecklists: rest, checklist: structuredClone(rest[0]), selectedChecklistId: rest[0].id }); });
    expect(useStore.getState().routeItem).toBeNull();
    // the same (now submitted) checklist is linked again, e.g. from its notice: it is not there
    act(() => { useStore.getState().setRouteItem('INSP-51'); });
    expect(useStore.getState().routeItem).toBe('INSP-51');
    expect(view.getByTestId('item-not-found').textContent).toContain('INSP-51');
  });

  it('Codex 4207530065 — a failed module read over a retained checklist still offers Retry', async () => {
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    const { view } = await mountField({ inspectionsLoad: 'error' });
    expect(view.getByTestId('checklist-title')).toBeTruthy();
    expect(view.getByTestId('inspections-stale')).toBeTruthy();
    expect(view.getByTestId('inspections-retry')).toBeTruthy();
  });

  it('Codex 4208735400 — Back to the list ends the episode: a later Forward to a submitted checklist reports it missing', async () => {
    const { useStore, view } = await mountField({ routeItem: 'INSP-51' });
    expect(useStore.getState().checklist?.id).toBe('INSP-51');
    // Back to /site/checklist, before submitting
    act(() => { useStore.getState().setRouteItem(null); });
    // INSP-51 is submitted from the list; it leaves the outstanding set
    const rest = useStore.getState().openChecklists.filter((c) => c.id !== 'INSP-51');
    act(() => { useStore.setState({ openChecklists: rest, checklist: structuredClone(rest[0]), selectedChecklistId: rest[0].id }); });
    // Forward to the saved /site/checklist/INSP-51 entry
    act(() => { useStore.getState().setRouteItem('INSP-51'); });
    expect(useStore.getState().routeItem).toBe('INSP-51');
    expect(view.getByTestId('item-not-found').textContent).toContain('INSP-51');
  });
});
