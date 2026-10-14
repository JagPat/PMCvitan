import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, renderHook, fireEvent } from '@testing-library/react';
import type { Decision } from '@vitan/shared';

/**
 * QA check 14 Oct 2026 (#482, items 3): the client has ONE "Decisions" screen — what waits on them first, then
 * the history — in place of "Decisions Waiting" and "Decision Log". The old `/decisions` path and notices that
 * open it still land, on that screen. The PMC's register is unchanged.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

const dec = (id: string, over: Partial<Decision> = {}): Decision => ({
  id, title: `Countertop ${id}`, room: 'Kitchen', status: 'pending', deciderKind: 'client', ageDays: 2,
  options: [
    { label: 'Option A', key: 'A', material: 'Granite', delta: 0, swatch: 'stone', recommended: true },
    { label: 'Option B', key: 'B', material: 'Quartz', delta: 20000, swatch: 'marble', recommended: false },
  ],
  ...over,
} as unknown as Decision);

const approved = (id: string): Decision =>
  dec(id, { status: 'approved', approver: 'Client', approvedOption: 'Option A', material: 'Granite', cost: 0, date: '01 Oct' } as Partial<Decision>);

async function load(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(), activeProjectId: 'ambli', projectLoadState: 'ready', role: 'client', lang: 'en',
    short: 'Ambli', screen: 'client-decisions', decisions: [dec('D-1'), approved('D-9')], ...overrides,
  });
  const { ScreenView } = await import('@/layout/ScreenView');
  return { useStore, r: render(<ScreenView />) };
}

describe('the client\'s one "Decisions" screen', () => {
  it('lists what waits on the client first, then the history without repeating it', async () => {
    const { r } = await load();
    const waiting = r.getByText('Decisions waiting for you');
    const history = r.getByTestId('decisions-history');
    expect(waiting.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(r.getByTestId('approve-D-1-A')).toBeTruthy();
    expect(history.querySelector('[data-testid="log-row-D-9"]')).toBeTruthy();
    expect(history.querySelector('[data-testid="log-row-D-1"]')).toBeNull();
    expect(history.textContent).toContain('History');
  });

  it('an old /decisions link opens the same screen, with the named decision marked in the history', async () => {
    Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout; the focused row scrolls itself into view
    const { r } = await load({ screen: 'decision-log', routeItem: 'D-9' });
    expect(r.getByText('Decisions waiting for you')).toBeTruthy();
    expect(r.getByTestId('log-row-D-9').getAttribute('aria-current')).toBe('true');
  });

  it('an old /decisions link to a decision still waiting on the client marks its card above the history (Codex 4268120376)', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { r } = await load({ screen: 'decision-log', routeItem: 'D-1' });
    expect(r.getByTestId('pending-card-D-1').getAttribute('aria-current')).toBe('true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('a history link on /client/decisions opens that record on the register path and marks it (Codex 4268120369)', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { useStore, r } = await load();
    fireEvent.click(r.getByTestId('log-link-D-9'));
    expect(useStore.getState()).toMatchObject({ screen: 'decision-log', routeItem: 'D-9', decisionFocus: null });
    expect(r.getByTestId('log-row-D-9').getAttribute('aria-current')).toBe('true');
    expect(r.getByText('Decisions waiting for you')).toBeTruthy();
  });

  it('a link naming a decision the register does not hold shows only the not-found boundary (Codex 4268290494)', async () => {
    const { useStore, r } = await load({ screen: 'decision-log', routeItem: 'D-404' });
    expect(r.getByText('Decisions')).toBeTruthy();
    expect(r.getByText('Show all decisions')).toBeTruthy();
    expect(r.queryByText('Decisions waiting for you')).toBeNull();
    expect(r.queryByTestId('approve-D-1-A')).toBeNull();
    expect(r.queryByTestId('decisions-caught-up')).toBeNull();
    // "Show all decisions" brings the whole screen back
    fireEvent.click(r.getByText('Show all decisions'));
    expect(useStore.getState().routeItem).toBeNull();
    expect(r.getByText('Decisions waiting for you')).toBeTruthy();
  });

  it('while the decisions are still loading, a named link shows only the loading boundary (Codex 4268290494)', async () => {
    const { r } = await load({ screen: 'decision-log', routeItem: 'D-404', decisions: [], decisionsLoad: 'loading', projectLoadState: 'loading' });
    expect(r.queryByTestId('decisions-loading') ?? r.queryByTestId('decisions-unavailable')).toBeTruthy();
    expect(r.queryByText('Decisions waiting for you')).toBeNull();
    expect(r.queryByTestId('decisions-caught-up')).toBeNull();
  });

  it('shows a short "all caught up" line above the history when nothing waits', async () => {
    const { r } = await load({ decisions: [approved('D-9')] });
    expect(r.getByTestId('decisions-caught-up').textContent).toContain('All caught up');
    expect(r.getByTestId('log-row-D-9')).toBeTruthy();
  });

  it('the client\'s menu has one "Decisions" entry, lit on either path, and /decisions stays routable', async () => {
    const { useStore } = await load({ screen: 'decision-log' });
    const { routableScreensFor, screensFor } = await import('@/lib/screens');
    const { useNavItems } = await import('@/layout/useNavItems');
    const keys = screensFor('client').map((m) => m.key);
    expect(keys).toContain('client-decisions');
    expect(keys).not.toContain('decision-log');
    expect(routableScreensFor('client')).toContain('decision-log');
    const nav = renderHook(() => useNavItems()).result.current;
    const entry = nav.find((m) => m.key === 'client-decisions')!;
    expect(entry.label).toBe('Decisions');
    expect(entry.active).toBe(true);
    expect(nav.filter((m) => /decision/i.test(m.label))).toHaveLength(1);
    expect(useStore.getState().screen).toBe('decision-log');
    // Hindi and Gujarati name it "decisions" too, as the register was named, not "approval" (Codex 4268290505)
    const { navLabelFor } = await import('@/lib/mobileNav');
    expect(navLabelFor('client-decisions', 'client', 'hi')).toBe(navLabelFor('decision-log', 'pmc', 'hi'));
    expect(navLabelFor('client-decisions', 'client', 'gu')).toBe(navLabelFor('decision-log', 'pmc', 'gu'));
  });

  it('the PMC keeps the Decision Log as it was', async () => {
    const { r } = await load({ role: 'pmc', screen: 'decision-log' });
    const { screensFor } = await import('@/lib/screens');
    expect(screensFor('pmc').map((m) => m.key)).toContain('decision-log');
    expect(r.getByText('Decision Register')).toBeTruthy();
    expect(r.queryByTestId('decisions-history')).toBeNull();
    expect(r.queryByText('Decisions waiting for you')).toBeNull();
  });
});
