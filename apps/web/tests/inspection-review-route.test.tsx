import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * Live bug 1 (Codex 4203960945, 4204448859, 4204448863) — `/review/<id>` and `/decisions/<id>` each
 * name ONE record. While the inspections are still
 * loading (or failed) and that inspection is not among the retained ones, the screen shows the load
 * boundary: never a retained, unrelated review with live approve/reject standing in for it.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
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

async function mountLog(state: Record<string, unknown>) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ role: 'pmc', screen: 'decision-log', ...state });
  const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
  return render(<DecisionLogScreen />);
}

describe('Decision Log — a named decision on an unsettled read (Codex 4204448863)', () => {
  it('shows "Loading decisions…", not the whole register, while the read is in flight', async () => {
    const view = await mountLog({ routeItem: 'DL-404', decisionsLoad: 'loading' });
    expect(view.getByTestId('decisions-loading')).toBeTruthy();
    expect(view.queryAllByTestId(/^log-row-/)).toHaveLength(0);
  });

  it('shows the unavailable boundary with Retry, not the register, when the read failed', async () => {
    const view = await mountLog({ routeItem: 'DL-404', decisionsLoad: 'error' });
    expect(view.getByTestId('decisions-unavailable')).toBeTruthy();
    expect(view.getByTestId('decisions-retry')).toBeTruthy();
    expect(view.queryAllByTestId(/^log-row-/)).toHaveLength(0);
  });

  it('while a committed command still reconciles, a named decision absent from the slice is loading, not missing', async () => {
    const view = await mountLog({ routeItem: 'DL-404', commandReconcilePending: true });
    expect(view.getByTestId('decisions-loading')).toBeTruthy();
    expect(view.queryByTestId('item-not-found')).toBeNull();
  });

  it('settled, the same absent decision is reported missing; a present one is shown even mid-load', async () => {
    expect((await mountLog({ routeItem: 'DL-404' })).getByTestId('item-not-found')).toBeTruthy();
    cleanup();
    vi.resetModules();
    Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout; the focused row scrolls itself into view
    const present = await mountLog({ routeItem: 'DL-014', decisionsLoad: 'loading' });
    expect(present.getByTestId('log-row-DL-014')).toBeTruthy();
  });
});

