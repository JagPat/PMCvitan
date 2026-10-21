import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { Role, ScreenKey } from '@vitan/shared';
import { splitMobileNav } from '@/lib/mobileNav';
import { enabledScreensFor, routableScreensFor, screensFor } from '@/lib/screens';
import { warmImports } from './warm-imports';

/**
 * Board decision 14 Oct 2026 (#482): the PMC reaches the Daily Site Log from its menu, on the desktop
 * sidebar and on the phone bar, as the engineer does. Before, a PMC could open it only by a link or
 * by typing /site/log.
 */

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/layout/LeftRail'), () => import('@/layout/BottomTabs'));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const keysOf = (xs: { key: ScreenKey }[]) => xs.map((x) => x.key);
const ALL_MODULES = ['activities', 'decisions', 'inspections', 'daily-log', 'drawings', 'nodes', 'orgs'];

async function loadShell() {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'pmc',
    lang: 'en',
    short: 'Villa Bodakdev',
    enabledModules: ALL_MODULES,
    capabilities: [],
  });
  const { LeftRail } = await import('@/layout/LeftRail');
  const { BottomTabs } = await import('@/layout/BottomTabs');
  return { useStore, LeftRail, BottomTabs };
}

describe('the PMC’s Daily Site Log menu entry', () => {
  it('is in the PMC’s nav, third, as the engineer’s is; the Dashboard stays home', () => {
    const pmc = keysOf(screensFor('pmc'));
    expect(pmc.slice(0, 3)).toEqual(['dashboard', 'inbox', 'daily-log']);
    expect(routableScreensFor('pmc')[0]).toBe('dashboard');
    // listed once: no longer a link-only screen as well
    expect(routableScreensFor('pmc').filter((k) => k === 'daily-log')).toHaveLength(1);
  });

  it('no other role gains it', () => {
    for (const role of ['client', 'contractor', 'consultant', 'architect'] as Role[]) {
      expect(routableScreensFor(role)).not.toContain('daily-log');
    }
  });

  it('follows the daily-log module like every other screen', () => {
    expect(keysOf(enabledScreensFor('pmc', ALL_MODULES))).toContain('daily-log');
    expect(keysOf(enabledScreensFor('pmc', ALL_MODULES.filter((m) => m !== 'daily-log')))).not.toContain('daily-log');
  });

  it('the phone bar is Dashboard · For You · Daily · Site Map, with Schedule and Portfolio behind More', () => {
    const items = enabledScreensFor('pmc', ALL_MODULES, ['materials', 'labour', 'commercial']);
    const { primary, secondary } = splitMobileNav(items, 'pmc');
    expect(keysOf(primary)).toEqual(['dashboard', 'inbox', 'daily-log', 'places']);
    expect(keysOf(secondary)).toContain('site-schedule');
    expect(keysOf(secondary)).toContain('portfolio');
    expect(primary.length + secondary.length).toBe(items.length);
  });

  it('the desktop sidebar shows "Daily Site Log" and opens it', async () => {
    const { useStore, LeftRail } = await loadShell();
    const r = render(<LeftRail />);
    fireEvent.click(r.getByRole('button', { name: /Daily Site Log/ }));
    expect(useStore.getState().screen).toBe('daily-log');
  });

  it('the phone bar carries a Daily tab that opens it', async () => {
    const { useStore, BottomTabs } = await loadShell();
    const r = render(<BottomTabs />);
    fireEvent.click(r.getByTestId('tab-daily-log'));
    expect(useStore.getState().screen).toBe('daily-log');
    expect(r.getByTestId('tab-places')).toBeInTheDocument();
    expect(r.queryByTestId('tab-site-schedule')).not.toBeInTheDocument();
  });
});
