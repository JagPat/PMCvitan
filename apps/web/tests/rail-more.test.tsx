import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within, act } from '@testing-library/react';
import type { Role } from '@vitan/shared';
import { splitMobileNav } from '@/lib/mobileNav';
import { enabledScreensFor } from '@/lib/screens';

/**
 * #482 QA item 2 (Jagrut, 14 Oct 2026): "At most 5 main menu items per role, the rest under More." The desktop
 * rail shows the same main items as the phone bar, then a folded "More" that opens in place. While folded it
 * carries the badges of the screens inside it, and a screen inside it that is on stage opens it.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const ALL_MODULES = ['activities', 'decisions', 'inspections', 'daily-log', 'drawings', 'nodes', 'orgs'];
const ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor', 'consultant', 'architect'];

async function loadRail(role: Role) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role,
    lang: 'en',
    short: 'Villa Bodakdev',
    enabledModules: ALL_MODULES,
    capabilities: [],
    screen: 'dashboard',
  });
  const { LeftRail } = await import('@/layout/LeftRail');
  return { useStore, LeftRail };
}

const railRows = (r: ReturnType<typeof render>) =>
  within(r.getByRole('navigation')).getAllByRole('button').map((b) => b.textContent ?? '');

describe('#482 QA: the desktop rail holds at most five rows, the rest under More', () => {
  it('every role’s folded rail shows at most five rows, More included', async () => {
    for (const role of ROLES) {
      const { LeftRail } = await loadRail(role);
      const r = render(<LeftRail />);
      expect(railRows(r).length, role).toBeLessThanOrEqual(5);
      cleanup();
    }
  });

  it('the PMC’s rail shows the phone bar’s screens, and More opens in place to the rest', async () => {
    const { LeftRail, useStore } = await loadRail('pmc');
    const r = render(<LeftRail />);
    const { primary, secondary } = splitMobileNav(enabledScreensFor('pmc', ALL_MODULES, []), 'pmc');
    const rows = railRows(r);
    expect(rows.slice(0, primary.length)).toEqual(primary.map((m) => m.label));
    expect(rows.at(-1)).toBe('More');
    expect(r.queryByRole('button', { name: /Decision Log/ })).not.toBeInTheDocument();

    const more = r.getByTestId('rail-more');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(railRows(r)).toHaveLength(primary.length + 1 + secondary.length);
    fireEvent.click(r.getByRole('button', { name: /Decision Log/ }));
    expect(useStore.getState().screen).toBe('decision-log');
  });

  it('a screen inside More that is on stage opens it', async () => {
    const { LeftRail, useStore } = await loadRail('contractor');
    const r = render(<LeftRail />);
    expect(r.getByTestId('rail-more')).toHaveAttribute('aria-expanded', 'false');
    act(() => useStore.setState({ screen: 'decision-log' }));
    expect(r.getByTestId('rail-more')).toHaveAttribute('aria-expanded', 'true');
    expect(r.getByRole('button', { name: /^Decisions/ })).toHaveAttribute('aria-current', 'page');
  });

  it('a folded More carries the badges of the screens inside it', async () => {
    const { LeftRail, useStore } = await loadRail('pmc');
    // two inspection reviews waiting: Inspection Review sits behind the PMC's More
    useStore.setState((s) => {
      s.reviews = [{ decided: false }, { decided: false }] as unknown as typeof s.reviews;
    });
    const r = render(<LeftRail />);
    const more = r.getByTestId('rail-more');
    expect(more).toHaveTextContent(/^More2$/);
    fireEvent.click(more);
    expect(more).toHaveTextContent(/^More$/);
    expect(r.getByRole('button', { name: /Inspection Review/ })).toHaveTextContent('2');
  });
});
