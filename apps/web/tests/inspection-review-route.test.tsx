import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * Live bug 1 (Codex 4203960945) — `/review/<id>` names ONE inspection. While the inspections are still
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
