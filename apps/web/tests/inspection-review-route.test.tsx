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
    const view = await mount({ routeItem: 'INSP-404', projectLoadState: 'ready', commandReconcilePending: true });
    expect(view.getByTestId('inspections-loading')).toBeTruthy();
    expect(view.queryByTestId('item-not-found')).toBeNull();
  });
});

describe('Inspection Review — the module-owned read (Codex 4205058538)', () => {
  it('a reconcile still owed unsettles a READY module slice: loading, never not-found', async () => {
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    const view = await mount({ routeItem: 'INSP-404', inspectionsLoad: 'ready', commandReconcilePending: true });
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
});
