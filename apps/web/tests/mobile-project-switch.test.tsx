import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { MembershipSummary } from '@vitan/shared';

/**
 * Mobile project context.
 *
 * The rail's `ProjectSwitcher` is `display:none` below 640px, so a phone had NO project identity
 * and no way to switch without going through Portfolio. The top bar now carries the active project
 * and opens the same switch. It must:
 *   • show the active project immediately, and truncate a long name instead of pushing controls off;
 *   • reuse `memberships` / `activeProjectId` / `switchProject` (no second copy of project state);
 *   • stay reachable from every screen (it lives in the shell's top bar, not on one screen);
 *   • leave Portfolio in place as the cross-project overview — the sheet LINKS to it.
 */

const MEMBERSHIPS: MembershipSummary[] = [
  { projectId: 'villa-b', name: 'Residence at Bodakdev', short: 'Villa Bodakdev', role: 'pmc', orgId: 'org-1', orgName: 'Vitan' },
  { projectId: 'ambli', name: 'Residence at Ambli', short: 'Residence at Ambli', role: 'pmc', orgId: 'org-1', orgName: 'Vitan' },
];

async function loadBar(overrides: Record<string, unknown> = {}) {
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
    memberships: MEMBERSHIPS,
    myOrgs: [],
    ...overrides,
  });
  const { TopBar } = await import('@/layout/TopBar');
  return { useStore, TopBar };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the mobile top bar carries the active project', () => {
  it('names the active project as soon as the shell renders', async () => {
    const { TopBar } = await loadBar();
    const r = render(<TopBar />);
    expect(r.getByTestId('mobile-project-switcher').textContent).toContain('Villa Bodakdev');
  });

  it('falls back to the live snapshot name while a membership list has not arrived', async () => {
    const { TopBar } = await loadBar({ memberships: [] });
    const r = render(<TopBar />);
    expect(r.getByTestId('mobile-project-switcher').textContent).toContain('Villa Bodakdev');
  });

  it('a long project name renders in full in the DOM and is clipped by the bar stylesheet', async () => {
    const long = 'Residence at Ambli for Mr & Mrs Shah — Phase 2 Interiors';
    const { TopBar } = await loadBar({
      short: long,
      memberships: [{ ...MEMBERSHIPS[0], short: long }],
    });
    const r = render(<TopBar />);
    const name = r.getByTestId('mobile-project-switcher').querySelector('span');
    expect(name?.textContent).toBe(long); // never silently shortened in the markup
    // jsdom does not apply CSS-module rules, so the clipping contract is asserted against the
    // stylesheet itself: the NAME truncates and the wrap can shrink, so the bell/persona controls
    // on the right are never pushed off a 390px viewport by a long name.
    const css = readFileSync('src/layout/TopBar.module.css', 'utf8');
    const projectName = css.slice(css.indexOf('.projectName'), css.indexOf('.projectChevron'));
    expect(projectName).toContain('text-overflow: ellipsis');
    expect(projectName).toContain('white-space: nowrap');
    expect(projectName).toContain('min-width: 0');
    const brandWrap = css.slice(css.indexOf('.brandWrap'), css.indexOf('.logoTile'));
    expect(brandWrap).toContain('min-width: 0');
  });

  it('with a single membership and no admin org there is nothing to switch to — the control is inert, not a lie', async () => {
    const { TopBar } = await loadBar({ memberships: [MEMBERSHIPS[0]] });
    const r = render(<TopBar />);
    const trigger = r.getByTestId('mobile-project-switcher');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(r.queryByTestId('project-sheet')).not.toBeInTheDocument();
  });
});

describe('switching from the top bar goes through the existing store path', () => {
  it('opens the sheet, lists memberships, and marks the active one', async () => {
    const { TopBar } = await loadBar();
    const r = render(<TopBar />);
    fireEvent.click(r.getByTestId('mobile-project-switcher'));
    expect(r.getByTestId('project-sheet')).toBeInTheDocument();
    expect(r.getByTestId('project-sheet-villa-b')).toHaveAttribute('aria-current', 'true');
    expect(r.getByTestId('project-sheet-ambli')).not.toHaveAttribute('aria-current');
  });

  it('choosing another project calls the store switchProject (not a second implementation)', async () => {
    const { useStore, TopBar } = await loadBar();
    const calls: string[] = [];
    useStore.setState({ switchProject: (id: string) => { calls.push(id); return Promise.resolve(true); } } as never);
    const r = render(<TopBar />);
    fireEvent.click(r.getByTestId('mobile-project-switcher'));
    fireEvent.click(r.getByTestId('project-sheet-ambli'));
    expect(calls).toEqual(['ambli']);
    // the sheet closes on the choice — the switch's own load boundary takes over
    expect(r.queryByTestId('project-sheet')).not.toBeInTheDocument();
  });

  it('the sheet does not replace Portfolio — it offers the cross-project overview as a destination', async () => {
    const { useStore, TopBar } = await loadBar();
    const r = render(<TopBar />);
    fireEvent.click(r.getByTestId('mobile-project-switcher'));
    fireEvent.click(r.getByTestId('project-sheet-portfolio'));
    expect(useStore.getState().screen).toBe('portfolio');
    expect(r.queryByTestId('project-sheet')).not.toBeInTheDocument();
  });

  it('the top bar reads project identity from the store, so an external switch is reflected without local state', async () => {
    const { useStore, TopBar } = await loadBar();
    const r = render(<TopBar />);
    expect(r.getByTestId('mobile-project-switcher').textContent).toContain('Villa Bodakdev');
    // e.g. a switch driven from Portfolio or a deep link
    act(() => { useStore.setState({ activeProjectId: 'ambli', short: 'Residence at Ambli' }); });
    expect(r.getByTestId('mobile-project-switcher').textContent).toContain('Residence at Ambli');
  });
});
