import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { warmImports } from './warm-imports';

/**
 * #482 — an empty screen shows one line pointing at the button that starts the work, in the person's
 * language, and only for a role that has that button.
 */

await warmImports(() => import('@/store/store'), () => import('@/screens/InspectionReviewScreen'), () => import('@/guide/EmptyHint'), () => import('@/store/projectScope'), () => import('@/screens/DecisionLogScreen'));

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

async function decisionLog(role: string, lang: 'en' | 'hi' | 'gu', decisions: unknown[] = [], extra: Record<string, unknown> = {}) {
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(), activeProjectId: 'ambli', projectLoadState: 'ready', role, lang,
    screen: 'decision-log', decisions, fetchAwaitingClient: () => Promise.resolve([]), ...extra,
  } as never);
  const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
  return render(<DecisionLogScreen />);
}

describe('the Decision Log with no decisions', () => {
  it('tells the PMC to tap + Issue decision, the button above it', async () => {
    const view = await decisionLog('pmc', 'en');
    expect(view.getByTestId('empty-hint').textContent).toBe('To put choices to the client, tap + Issue decision above.');
    expect(view.getByTestId('issue-decision').textContent).toContain('Issue decision');
  });

  it.each(['hi', 'gu'] as const)('the line is in %s, with no English words left in it', async (lang) => {
    const view = await decisionLog('pmc', lang);
    const text = view.getByTestId('empty-hint').textContent ?? '';
    expect(text).toContain('+');
    expect(text).not.toMatch(/[A-Za-z]/);
  });

  it('a register that has decisions but a search hiding them all is not empty: no line', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const seeded = useStore.getState().decisions;
    expect(seeded.length).toBeGreaterThan(0);
    vi.resetModules();
    const view = await decisionLog('pmc', 'en', seeded);
    fireEvent.change(view.getByTestId('decision-search'), { target: { value: 'nothing matches this zzz' } });
    expect(view.getByText(/No decisions match your filters/)).toBeTruthy();
    expect(view.queryByTestId('empty-hint')).toBeNull();
  });

  it.each(['engineer', 'contractor', 'consultant'] as const)('a %s, who has no Issue decision button, is shown no line', async (role) => {
    const view = await decisionLog(role, 'en');
    expect(view.queryByTestId('issue-decision')).toBeNull();
    expect(view.queryByTestId('empty-hint')).toBeNull();
  });

  it.each([
    ['while the decisions are still loading', { decisionsLoad: 'loading' }],
    ['when the decisions read failed (an empty last-good register)', { decisionsLoad: 'error' }],
    ['while a published decision is still reconciling', { commandReconcileOwed: { decisions: true, dailyLog: false, drawings: false, inspections: false, activities: false } }],
  ])('no line %s: the register may not really be empty', async (_label, extra) => {
    const view = await decisionLog('pmc', 'en', [], extra);
    expect(view.queryByTestId('empty-hint')).toBeNull();
  });
});
