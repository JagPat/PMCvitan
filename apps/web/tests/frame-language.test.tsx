import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { Checklist, Lang, MembershipSummary, Role } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 6251162266 V-1018-3 — in Hindi and Gujarati the desktop rail kept its frame in English for every role
 * ("PMC CONSOLE", "PROJECT", "SIGNED IN AS", "Sign out"). The phone's top bar and its sheets carry the same
 * frame. "VITAN" is the firm's name and "PMC" stays in brackets (#827); project and people's names are data.
 * V-1018-4 — the engineer's checklist showed its served date "18 Oct 2026" in English while the review localised it.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const ALL_MODULES = ['activities', 'decisions', 'inspections', 'daily-log', 'drawings', 'nodes', 'orgs'];
const ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor', 'consultant'];
const MEMBERSHIPS: MembershipSummary[] = [
  { projectId: 'villa-b', name: 'Villa Bodakdev', short: 'Villa Bodakdev', role: 'pmc', orgId: 'o1', orgName: 'Vitan' },
  { projectId: 'tower-c', name: 'Tower Chandkheda', short: 'Tower Chandkheda', role: 'engineer', orgId: 'o1', orgName: 'Vitan' },
];
/** the build stamp's commit, and the language picker, which names each language in its own script ('EN', 'English') */
const BUILD_SHA = 'unknown';
const LANGUAGE_NAMES = ['EN', 'English'];
/** the firm's name, the PMC acronym, project names, the person, the build stamp and the stage typed in Team settings */
const DATA = ['VITAN', 'Vitan', 'PMC', 'Villa Bodakdev', 'Tower Chandkheda', 'Asha Rao', 'Planning', BUILD_SHA, ...LANGUAGE_NAMES];

async function loadFrame(role: Role, lang: Lang, userName: string | null = 'Asha Rao') {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b', projectLoadState: 'ready', role, lang, userName,
    short: 'Villa Bodakdev', stage: 'Planning', memberships: MEMBERSHIPS,
    myOrgs: [{ id: 'o1', name: 'Vitan', role: 'owner' }] as never,
    enabledModules: ALL_MODULES, capabilities: [], screen: 'dashboard',
  });
  return useStore;
}

describe.each(['hi', 'gu'] as const)('the frame in %s (V-1018-3)', (lang) => {
  it.each(ROLES)('the desktop rail for %s, with the project list open, shows no English', async (role) => {
    await loadFrame(role, lang);
    const { LeftRail } = await import('@/layout/LeftRail');
    const view = render(<LeftRail />);
    fireEvent.click(view.getByTestId('project-switcher'));
    expect(leftoverEnglish(view.container, DATA)).toEqual([]);
  });

  it('with no name on the account, the rail names the role in the same language', async () => {
    await loadFrame('contractor', lang, null);
    const { LeftRail } = await import('@/layout/LeftRail');
    const view = render(<LeftRail />);
    expect(leftoverEnglish(view.container, DATA)).toEqual([]);
  });

  it.each(ROLES)('the phone top bar and its project sheet for %s show no English', async (role) => {
    await loadFrame(role, lang);
    const { TopBar } = await import('@/layout/TopBar');
    const view = render(<TopBar />);
    expect(leftoverEnglish(view.container, DATA)).toEqual([]);
    fireEvent.click(view.getByTestId('mobile-project-switcher'));
    expect(view.getByTestId('project-sheet')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('an empty More sheet shows no English', async () => {
    await loadFrame('client', lang);
    const { MoreSheet } = await import('@/layout/MobileSheet');
    const view = render(<MoreSheet items={[]} onClose={() => {}} />);
    expect(leftoverEnglish(view.baseElement, DATA)).toEqual([]);
  });
});

describe('the frame in English is unchanged', () => {
  it('reads as before', async () => {
    await loadFrame('pmc', 'en', null);
    const { LeftRail } = await import('@/layout/LeftRail');
    const view = render(<LeftRail />);
    fireEvent.click(view.getByTestId('project-switcher'));
    const text = view.container.textContent!;
    for (const s of ['VITAN', 'PMC CONSOLE', 'PROJECT', 'SIGNED IN AS', 'Project manager (PMC)', 'Sign out', 'New project', 'Manage team →', 'build ']) {
      expect(text).toContain(s);
    }
    expect(view.getByTestId('project-switcher').getAttribute('aria-label')).toBe('Project: Villa Bodakdev — switch project');
    expect(view.getByRole('group', { name: 'Switch project' })).toBeTruthy();
  });

  it('the phone bar reads as before', async () => {
    await loadFrame('engineer', 'en');
    const { TopBar } = await import('@/layout/TopBar');
    const view = render(<TopBar />);
    expect(view.getByTestId('mobile-project-switcher').getAttribute('aria-label')).toBe('Project: Villa Bodakdev — switch project');
    expect(view.getByLabelText('Sign out')).toBeTruthy();
    fireEvent.click(view.getByTestId('mobile-project-switcher'));
    const sheet = view.getByTestId('project-sheet');
    expect(sheet.textContent).toContain('Switch project');
    expect(sheet.textContent).toContain('Project manager (PMC)');
    expect(sheet.textContent).toContain('New project');
  });
});

describe('V-1018-4 — the engineer checklist date', () => {
  const CL = { id: 'INSP-026', title: 'Slab casting', zone: 'Ground floor', date: '18 Oct 2026', submitted: false, items: [] } as unknown as Checklist;

  it.each([
    ['en', '18 Oct 2026'],
    ['hi', new Intl.DateTimeFormat('hi-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2026, 9, 18))],
    ['gu', new Intl.DateTimeFormat('gu-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2026, 9, 18))],
  ] as const)('in %s reads like the review screen', async (lang, shown) => {
    const useStore = await loadFrame('engineer', lang);
    useStore.setState({ openChecklists: [CL], checklist: CL, selectedChecklistId: null });
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const view = render(<EngineerChecklistScreen />);
    expect(view.getByTestId('checklist-date').textContent).toBe(shown);
    if (lang !== 'en') expect(view.getByTestId('checklist-date').textContent).not.toMatch(/[A-Za-z]/);
  });
});
