import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * Live bug 1a (Codex 4204448859, 4204448863) — `/decisions/<id>` names ONE decision. While the
 * decision read is still loading, failed, or owes a committed command's reconcile, and that decision
 * is not in the retained slice, the screen shows the load boundary: never the whole register standing
 * in for it, and never "not found" before the slice can say so.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
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
    const view = await mountLog({ routeItem: 'DL-404', commandReconcilePending: true, commandReconcileOwed: { decisions: true, dailyLog: false, drawings: false, inspections: false, activities: false } });
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

describe('"Show all decisions" shows all (Codex 4206188374)', () => {
  it('clears the search and status filters the mounted register kept from before the link', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const view = await mountLog({});
    const { useStore } = await import('@/store/store');
    const all = view.getAllByTestId(/^log-row-/).length;
    fireEvent.click(view.getByTestId('filter-approved'));
    fireEvent.change(view.getByTestId('decision-search'), { target: { value: 'zzz-no-match' } });
    expect(view.queryAllByTestId(/^log-row-/)).toHaveLength(0);
    // an in-app link names a decision that is not there; the register stays mounted underneath
    act(() => { useStore.getState().setRouteItem('DL-404'); });
    expect(view.getByTestId('item-not-found')).toBeTruthy();
    fireEvent.click(view.getByTestId('item-not-found-show-all'));
    expect(view.queryByTestId('item-not-found')).toBeNull();
    expect((view.getByTestId('decision-search') as HTMLInputElement).value).toBe('');
    expect(view.getAllByTestId(/^log-row-/)).toHaveLength(all);
  });
});
