import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * #482 — an empty screen shows one line pointing at the button that starts the work, in the person's
 * language, and only for a role that has that button.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

async function emptyReview(lang: 'en' | 'hi' | 'gu') {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ role: 'pmc', screen: 'inspect-review', lang, reviews: [], projectLoadState: 'ready' });
  const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
  return render(<InspectionReviewScreen />);
}

describe('empty-screen lines', () => {
  it('an empty Inspection Review tells the PMC to tap + New checklist, the button above it', async () => {
    const view = await emptyReview('en');
    expect(view.getByText(/No inspections awaiting review/)).toBeTruthy();
    const hint = view.getByTestId('empty-hint');
    expect(hint.textContent).toBe('To send the engineer something to check, tap + New checklist above.');
    expect(view.getByTestId('new-checklist').textContent).toContain('New checklist');
    // inside the centred empty message, not left-aligned on its own under it
    expect(hint.parentElement?.style.textAlign).toBe('center');
    expect(hint.parentElement?.textContent).toContain('No inspections awaiting review');
  });

  it.each(['hi', 'gu'] as const)('the line is in %s, with no English words left in it', async (lang) => {
    const view = await emptyReview(lang);
    const text = view.getByTestId('empty-hint').textContent ?? '';
    expect(text).toContain('+');
    expect(text).not.toMatch(/[A-Za-z]/);
  });

  it('a review waiting on the PMC is not an empty screen: no line', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    useStore.setState({ role: 'pmc', screen: 'inspect-review', projectLoadState: 'ready' });
    expect(useStore.getState().reviews.length).toBeGreaterThan(0);
    const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
    const view = render(<InspectionReviewScreen />);
    expect(view.queryByTestId('empty-hint')).toBeNull();
  });

  it.each(['engineer', 'contractor', 'consultant', 'client'] as const)('a %s, who has no New checklist button, is shown no line', async (role) => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    useStore.setState({ role });
    const { EmptyHint } = await import('@/guide/EmptyHint');
    const view = render(<EmptyHint task="checklist" />);
    expect(view.queryByTestId('empty-hint')).toBeNull();
  });
});
