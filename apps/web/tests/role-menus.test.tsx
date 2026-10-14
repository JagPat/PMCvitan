import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Role, ScreenKey } from '@vitan/shared';
import { navLabelFor, splitMobileNav, MOBILE_MAX_TABS } from '@/lib/mobileNav';
import { enabledScreensFor, routableScreensFor, screensFor } from '@/lib/screens';

/**
 * #482 QA (Jagrut, 14 Oct 2026, per-role check on the live QA project): "Team Access & Login" is a dead end in
 * the engineer's and the contractor's menus, so it leaves them; and the engineer, contractor and consultant
 * menus call the decision register "Decisions" (the PMC and the client keep "Decision Log"). Every phone bar
 * stays at most five slots, the rest behind More.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const keysOf = (xs: { key: ScreenKey }[]) => xs.map((x) => x.key);
const ALL_MODULES = ['activities', 'decisions', 'inspections', 'daily-log', 'drawings', 'nodes', 'orgs', 'site-visits'];
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
  });
  const { LeftRail } = await import('@/layout/LeftRail');
  return LeftRail;
}

describe('#482 QA role menus', () => {
  it('the engineer and the contractor no longer carry "Team Access & Login" in their menus; its URL still opens', () => {
    for (const role of ['engineer', 'contractor'] as Role[]) {
      expect(keysOf(screensFor(role))).not.toContain('team-access');
      expect(keysOf(enabledScreensFor(role, ALL_MODULES, ['materials', 'labour', 'commercial']))).not.toContain('team-access');
      expect(routableScreensFor(role)).toContain('team-access');
    }
  });

  it('the engineer, contractor and consultant call the register "Decisions"; the PMC keeps "Decision Log"', () => {
    for (const role of ['engineer', 'contractor', 'consultant'] as Role[]) {
      const entry = screensFor(role).find((m) => m.key === 'decision-log');
      expect(entry?.label).toBe('Decisions');
      expect(navLabelFor('decision-log', role, 'en')).toBe('Decisions');
    }
    expect(screensFor('pmc').find((m) => m.key === 'decision-log')?.label).toBe('Decision Log');
    // #857 — the client's register is the history half of their one "Decisions" entry, so no separate entry
    expect(screensFor('client').find((m) => m.key === 'decision-log')).toBeUndefined();
  });

  it('Hindi and Gujarati keep their word for decisions', () => {
    expect(navLabelFor('decision-log', 'contractor', 'hi')).toBe(navLabelFor('decision-log', 'pmc', 'hi'));
    expect(navLabelFor('decision-log', 'contractor', 'gu')).toBe(navLabelFor('decision-log', 'pmc', 'gu'));
  });

  it('every role’s phone bar has at most five slots, More included, and drops nothing', () => {
    for (const role of ROLES) {
      const items = enabledScreensFor(role, ALL_MODULES, ['materials', 'labour', 'commercial']);
      const { primary, secondary } = splitMobileNav(items, role);
      expect(primary.length + (secondary.length ? 1 : 0)).toBeLessThanOrEqual(MOBILE_MAX_TABS);
      expect(primary.length + secondary.length).toBe(items.length);
    }
  });

  // Site Visits (#792, QA item 6) is the contractor's sixth screen, so their bar keeps four and More holds the rest
  it('the contractor’s bar keeps four screens; More holds Decisions and Site Visits', () => {
    const { primary, secondary } = splitMobileNav(enabledScreensFor('contractor', ALL_MODULES), 'contractor');
    expect(keysOf(primary)).toEqual(['dashboard', 'inbox', 'places', 'drawings']);
    expect(keysOf(secondary)).toEqual(['decision-log', 'site-visits']);
  });

  it('the contractor’s desktop sidebar reads "Decisions" and has no access screen', async () => {
    const LeftRail = await loadRail('contractor');
    const r = render(<LeftRail />);
    expect(r.getByRole('button', { name: /^Decisions/ })).toBeInTheDocument();
    expect(r.queryByRole('button', { name: /Decision Log/ })).not.toBeInTheDocument();
    expect(r.queryByRole('button', { name: /Team Access/ })).not.toBeInTheDocument();
  });

  it('the PMC’s desktop sidebar still reads "Decision Log"', async () => {
    const LeftRail = await loadRail('pmc');
    const r = render(<LeftRail />);
    expect(r.getByRole('button', { name: /Decision Log/ })).toBeInTheDocument();
  });
});
