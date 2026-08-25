import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { splitMobileNav, MOBILE_MAX_TABS, MOBILE_PRIMARY_PREFERENCE } from '@/lib/mobileNav';
import { enabledScreensFor } from '@/lib/screens';
import type { Role, ScreenKey } from '@vitan/shared';

/**
 * Mobile information architecture.
 *
 * The bottom bar used to render EVERY screen the role could reach — thirteen tabs for a PMC on a
 * 390px phone. The split is a PRESENTATION concern layered over the existing permission pipeline
 * (`enabledScreensFor` → role list → per-project capability → enabled modules): it must never add a
 * destination the role cannot reach, never drop one it can, and must keep the overflow's attention
 * badges visible on the More tab.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const keysOf = (xs: { key: ScreenKey }[]) => xs.map((x) => x.key);
const ALL_MODULES = ['activities', 'decisions', 'inspections', 'daily-log', 'drawings', 'nodes', 'orgs'];

describe('splitMobileNav — the primary/secondary composition', () => {
  it('a PMC gets For You · Schedule · Places · Portfolio, and everything else goes to More', () => {
    const items = enabledScreensFor('pmc', ALL_MODULES, ['materials', 'labour', 'commercial']);
    const { primary, secondary } = splitMobileNav(items);
    expect(keysOf(primary)).toEqual(['inbox', 'site-schedule', 'places', 'portfolio']);
    // the secondary half is the exact remainder — nothing invented, nothing lost
    expect(keysOf(secondary)).toEqual(['dashboard', 'decision-log', 'drafts', 'inspect-review', 'drawings', 'materials', 'labour', 'commercial', 'team']);
    expect(primary.length + secondary.length).toBe(items.length);
  });

  it('never exceeds five bars, so a 390px viewport never compresses the tabs', () => {
    for (const role of ['pmc', 'client', 'engineer', 'contractor', 'consultant'] as Role[]) {
      const items = enabledScreensFor(role, ALL_MODULES, ['materials', 'labour', 'commercial']);
      const { primary, secondary } = splitMobileNav(items);
      const bars = primary.length + (secondary.length > 0 ? 1 : 0);
      expect(bars).toBeLessThanOrEqual(MOBILE_MAX_TABS);
    }
  });

  it('a role without Schedule or Portfolio gets its OWN screens in those slots — nothing is fabricated', () => {
    const items = enabledScreensFor('client', ALL_MODULES, []);
    const { primary, secondary } = splitMobileNav(items);
    // the client has neither 'site-schedule' nor 'portfolio' — the bar fills from the role's own order
    expect(keysOf(primary)).not.toContain('site-schedule');
    expect(keysOf(primary)).not.toContain('portfolio');
    expect(keysOf(primary)[0]).toBe('inbox');
    expect(keysOf(primary)).toContain('places');
    const all = new Set([...keysOf(primary), ...keysOf(secondary)]);
    expect(all).toEqual(new Set(keysOf(items)));
  });

  it('a short list keeps every screen on the bar and needs no More', () => {
    const items = enabledScreensFor('contractor', ALL_MODULES, []);
    expect(items.length).toBeLessThanOrEqual(MOBILE_MAX_TABS);
    const { primary, secondary } = splitMobileNav(items);
    expect(secondary).toEqual([]);
    expect(keysOf(primary).sort()).toEqual(keysOf(items).sort());
  });

  it('preference order is honoured, but only for screens the role actually holds', () => {
    const items = enabledScreensFor('engineer', ALL_MODULES, ['materials', 'labour', 'commercial']);
    const { primary } = splitMobileNav(items);
    const held = MOBILE_PRIMARY_PREFERENCE.filter((k) => keysOf(items).includes(k));
    expect(keysOf(primary).slice(0, held.length)).toEqual(held);
  });

  it('every item lands in exactly one half, for every role', () => {
    for (const role of ['pmc', 'client', 'engineer', 'contractor', 'consultant'] as Role[]) {
      const items = enabledScreensFor(role, ALL_MODULES, ['materials', 'labour', 'commercial']);
      const { primary, secondary } = splitMobileNav(items);
      const merged = [...keysOf(primary), ...keysOf(secondary)];
      expect(new Set(merged).size).toBe(merged.length); // no duplication
      expect(new Set(merged)).toEqual(new Set(keysOf(items))); // no loss
    }
  });
});

describe('the More sheet respects capability + module gating (it filters nothing itself)', () => {
  it('a NON-pilot project has no Materials/Labour/Commercial in either half', () => {
    const items = enabledScreensFor('pmc', ALL_MODULES, []); // capabilities absent = non-pilot
    const { primary, secondary } = splitMobileNav(items);
    const all = [...keysOf(primary), ...keysOf(secondary)];
    expect(all).not.toContain('materials');
    expect(all).not.toContain('labour');
    expect(all).not.toContain('commercial');
  });

  it('a disabled MODULE stays out of More too', () => {
    const withoutDrawings = ALL_MODULES.filter((m) => m !== 'drawings');
    const items = enabledScreensFor('pmc', withoutDrawings, ['materials']);
    const { primary, secondary } = splitMobileNav(items);
    expect([...keysOf(primary), ...keysOf(secondary)]).not.toContain('drawings');
  });

  it('enabling ONE capability adds exactly that screen to More', () => {
    const before = splitMobileNav(enabledScreensFor('pmc', ALL_MODULES, []));
    const after = splitMobileNav(enabledScreensFor('pmc', ALL_MODULES, ['labour']));
    expect(keysOf(after.primary)).toEqual(keysOf(before.primary)); // the bar is unchanged
    const added = keysOf(after.secondary).filter((k) => !keysOf(before.secondary).includes(k));
    expect(added).toEqual(['labour']); // exactly that screen, nothing else
  });
});

async function loadTabs(overrides: Record<string, unknown> = {}) {
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
    short: 'Villa Bodakdev',
    enabledModules: ALL_MODULES,
    capabilities: [],
    ...overrides,
  });
  const { BottomTabs } = await import('@/layout/BottomTabs');
  return { useStore, BottomTabs };
}

describe('BottomTabs — the rendered bar', () => {
  it('renders four destinations plus More for a PMC', async () => {
    const { BottomTabs } = await loadTabs();
    const r = render(<BottomTabs />);
    for (const key of ['inbox', 'site-schedule', 'places', 'portfolio']) {
      expect(r.getByTestId(`tab-${key}`)).toBeInTheDocument();
    }
    expect(r.getByTestId('tab-more')).toBeInTheDocument();
    // a secondary screen is NOT a permanent tab
    expect(r.queryByTestId('tab-decision-log')).not.toBeInTheDocument();
  });

  it('More opens a sheet holding the secondary screens, and navigating closes it', async () => {
    const { useStore, BottomTabs } = await loadTabs();
    const r = render(<BottomTabs />);
    fireEvent.click(r.getByTestId('tab-more'));
    expect(r.getByTestId('more-sheet')).toBeInTheDocument();
    expect(r.getByTestId('more-item-decision-log')).toBeInTheDocument();
    fireEvent.click(r.getByTestId('more-item-decision-log'));
    expect(useStore.getState().screen).toBe('decision-log');
    expect(r.queryByTestId('more-sheet')).not.toBeInTheDocument();
  });

  it('attention never hides behind More: the tab carries the overflow badge total', async () => {
    const { BottomTabs } = await loadTabs({
      decisions: [
        { id: 'D-1', title: 'a', room: 'GF', status: 'pending', options: [], ageDays: 1, photoSwatch: 'tile' },
        { id: 'D-2', title: 'b', room: 'GF', status: 'pending', options: [], ageDays: 1, photoSwatch: 'tile', draft: true },
      ],
    });
    const r = render(<BottomTabs />);
    // the one DRAFT decision badges 'drafts', which lives in More
    expect(r.getByTestId('tab-more').textContent).toContain('1');
  });

  it('a role whose screens all fit shows no More tab', async () => {
    const { BottomTabs } = await loadTabs({ role: 'contractor' });
    const r = render(<BottomTabs />);
    expect(r.queryByTestId('tab-more')).not.toBeInTheDocument();
    expect(r.getByTestId('tab-places')).toBeInTheDocument();
  });
});
