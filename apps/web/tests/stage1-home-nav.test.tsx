import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Lang, Role, ScreenKey } from '@vitan/shared';
import { navLabelFor, splitMobileNav } from '@/lib/mobileNav';
import { enabledScreensFor } from '@/lib/screens';
import { HOME_NAV_CAPABILITY, readHomeNavMemory, resolveHomeNav, writeHomeNavMemory } from '@/lib/homeNav';

/**
 * Stage 1 redesign (#482, Rev 3.1 unit H1) — navigation behind the per-project `home-nav` server switch (H0).
 * Switch on: the engineer's bar is Home · Today · Site · Site Map · More, the PMC's "Daily" tab reads
 * "Site Log", every other role's bar is unchanged, and the desktop rail shows the same main items. Switch
 * off (the default): today's bars exactly. Offline, the device's last known setting holds.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});
beforeEach(() => globalThis.localStorage?.clear());

const keysOf = (xs: { key: ScreenKey }[]) => xs.map((x) => x.key);
const ALL_MODULES = ['activities', 'decisions', 'inspections', 'daily-log', 'drawings', 'nodes', 'orgs'];
const ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor', 'consultant'];
const LANGS: Lang[] = ['en', 'hi', 'gu'];
const itemsFor = (role: Role) => enabledScreensFor(role, ALL_MODULES, ['materials', 'labour', 'commercial']);

describe('the bars with the switch on', () => {
  it('the engineer gains the Site Map beside Today and Site', () => {
    expect(keysOf(splitMobileNav(itemsFor('engineer'), 'engineer', true).primary)).toEqual(['dashboard', 'inbox', 'daily-log', 'places']);
    expect(keysOf(splitMobileNav(itemsFor('engineer'), 'engineer', false).primary)).toEqual(['dashboard', 'inbox', 'daily-log']);
  });

  it('the PMC, client, contractor and consultant keep today’s bar', () => {
    for (const role of ['pmc', 'client', 'contractor', 'consultant'] as Role[]) {
      expect(keysOf(splitMobileNav(itemsFor(role), role, true).primary), role).toEqual(keysOf(splitMobileNav(itemsFor(role), role).primary));
    }
  });

  it('every screen a role holds stays reachable from the bar or More, and the bar never exceeds five', () => {
    for (const role of ROLES) {
      const items = itemsFor(role);
      const { primary, secondary } = splitMobileNav(items, role, true);
      expect(new Set([...keysOf(primary), ...keysOf(secondary)]), role).toEqual(new Set(keysOf(items)));
      expect(primary.length + secondary.length, role).toBe(items.length);
      expect(primary.length + (secondary.length > 0 ? 1 : 0), role).toBeLessThanOrEqual(5);
    }
  });

  it('the PMC’s Daily tab reads Site Log in every language; the engineer keeps Today and Site', () => {
    expect(LANGS.map((l) => navLabelFor('daily-log', 'pmc', l, true))).toEqual(['Site Log', 'साइट लॉग', 'સાઇટ લોગ']);
    expect(navLabelFor('daily-log', 'pmc', 'en')).toBe('Daily');
    expect(navLabelFor('daily-log', 'engineer', 'en', true)).toBe('Site');
    expect(navLabelFor('inbox', 'engineer', 'en', true)).toBe('Today');
    expect(navLabelFor('places', 'engineer', 'hi', true)).toBe(navLabelFor('places', 'engineer', 'hi'));
  });
});

describe('the switch reader', () => {
  it('follows the server once the shell has reported, and remembers it for this device and project', () => {
    expect(resolveHomeNav('p1', true, true)).toBe(true);
    expect(resolveHomeNav('p1', true, false)).toBe(false);
    writeHomeNavMemory('p1', true);
    expect(readHomeNavMemory('p1')).toBe(true);
    expect(readHomeNavMemory('p2'), 'another project has its own setting').toBeNull();
  });

  it('offline (shell not reported) it uses the last known setting, and is off with none', () => {
    expect(resolveHomeNav('p1', false, false)).toBe(false);
    writeHomeNavMemory('p1', true);
    expect(resolveHomeNav('p1', false, false)).toBe(true);
    expect(resolveHomeNav(null, false, false)).toBe(false);
    writeHomeNavMemory('p1', false);
    expect(resolveHomeNav('p1', false, false)).toBe(false);
  });
});

async function loadNav(overrides: Record<string, unknown>) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'engineer',
    lang: 'en',
    short: 'Villa Bodakdev',
    enabledModules: ALL_MODULES,
    capabilities: [],
    capabilitiesKnown: true,
    ...overrides,
  });
  const { BottomTabs } = await import('@/layout/BottomTabs');
  const { LeftRail } = await import('@/layout/LeftRail');
  return { useStore, BottomTabs, LeftRail };
}

describe('the rendered bar and rail', () => {
  it('switch off: the engineer’s bar is today’s', async () => {
    const { BottomTabs } = await loadNav({});
    const r = render(<BottomTabs />);
    expect(r.queryByTestId('tab-places')).not.toBeInTheDocument();
  });

  it('switch on: the engineer’s bar gains Site Map, which opens it, and the switch is remembered', async () => {
    const { useStore, BottomTabs } = await loadNav({ capabilities: [HOME_NAV_CAPABILITY] });
    const r = render(<BottomTabs />);
    for (const key of ['dashboard', 'inbox', 'daily-log', 'places']) expect(r.getByTestId(`tab-${key}`)).toBeInTheDocument();
    expect(r.getByTestId('tab-more')).toBeInTheDocument();
    fireEvent.click(r.getByTestId('tab-places'));
    expect(useStore.getState().screen).toBe('places');
    expect(readHomeNavMemory('villa-b')).toBe(true);
  });

  it('opened with no signal, the bar keeps this device’s last known setting', async () => {
    writeHomeNavMemory('villa-b', true);
    const { BottomTabs } = await loadNav({ capabilitiesKnown: false });
    const r = render(<BottomTabs />);
    expect(r.getByTestId('tab-places')).toBeInTheDocument();
  });

  it('switch on: the PMC’s tab reads Site Log, in Gujarati too', async () => {
    const { useStore, BottomTabs } = await loadNav({ role: 'pmc', capabilities: [HOME_NAV_CAPABILITY] });
    const r = render(<BottomTabs />);
    expect(r.getByTestId('tab-daily-log').textContent).toBe('Site Log');
    act(() => useStore.setState({ lang: 'gu' }));
    expect(r.getByTestId('tab-daily-log').textContent).toBe('સાઇટ લોગ');
  });

  it('switch on: the desktop rail shows the engineer the same main items, Site Map among them', async () => {
    const { LeftRail } = await loadNav({ capabilities: [HOME_NAV_CAPABILITY] });
    const r = render(<LeftRail />);
    const site = r.getByRole('button', { name: /^Site Map/ });
    const more = r.getByRole('button', { name: /More/ });
    // the main items come before More's toggle, so Site Map is on the rail itself, not folded inside More
    expect(site.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
