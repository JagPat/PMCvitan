import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { navLabelFor } from '@/lib/mobileNav';
import { SCREEN_META } from '@/lib/screens';

/** B9 (F-11, F-16, F-21) — one name per screen, no dead switcher, and copy that counts right. */

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('one English name per screen', () => {
  it('rail, phone tabs and More all call the map "Site Map" and the register "Decision Log"', () => {
    for (const role of ['pmc', 'client', 'contractor', 'consultant'] as const) {
      expect(navLabelFor('places', role, 'en')).toBe('Site Map');
      expect(navLabelFor('decision-log', role, 'en')).toBe('Decision Log');
    }
    expect(SCREEN_META.places.short).toBe(SCREEN_META.places.label);
    expect(SCREEN_META['decision-log'].short).toBe(SCREEN_META['decision-log'].label);
  });
});

describe('the rail project switcher', () => {
  async function load(memberships: Array<Record<string, string>>, myOrgs: unknown[] = []) {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    const { ProjectSwitcher } = await import('@/layout/ProjectSwitcher');
    useStore.setState(getInitialState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'p1', projectLoadState: 'ready', role: 'pmc', short: 'Alpha', memberships, myOrgs } as any);
    return ProjectSwitcher;
  }

  it('with one project and nothing to create, the name is plain text — not a button that does nothing', async () => {
    const ProjectSwitcher = await load([{ projectId: 'p1', short: 'Alpha', role: 'pmc', orgId: 'o1' }]);
    render(<ProjectSwitcher />);
    expect(screen.getByTestId('project-switcher').tagName).toBe('DIV');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('project-switcher').textContent).toBe('Alpha');
  });

  it('with more than one project it is a real disclosure trigger', async () => {
    const ProjectSwitcher = await load([
      { projectId: 'p1', short: 'Alpha', role: 'pmc', orgId: 'o1' },
      { projectId: 'p2', short: 'Beta', role: 'pmc', orgId: 'o1' },
    ]);
    render(<ProjectSwitcher />);
    const trigger = screen.getByTestId('project-switcher');
    expect(trigger.tagName).toBe('BUTTON');
    // a disclosure (aria-expanded) over a plain group — no menu claim (focus-foundation F-1a)
    expect(trigger.hasAttribute('aria-haspopup')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('copy that counts right', () => {
  beforeEach(() => vi.resetModules());

  it('the Decision Log header says 1 DECISION, not 1 DECISIONS', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
    useStore.setState(getInitialState());
    useStore.setState((st) => { st.decisions = st.decisions.filter((d) => !d.draft).slice(0, 1); });
    render(<DecisionLogScreen />);
    expect(screen.getByText('1 DECISION')).toBeTruthy();
  });

  it('the org add button names the role chosen — it can add a plain member', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    const { TeamScreen } = await import('@/screens/TeamScreen');
    useStore.setState(getInitialState());
    useStore.setState((st) => {
      st.activeProjectId = 'p1';
      st.role = 'pmc';
      st.memberships = [{ projectId: 'p1', name: 'Live Project', short: 'Live', role: 'pmc', orgId: 'o1', orgName: 'Vitan' }];
      st.myOrgs = [{ id: 'o1', name: 'Vitan', slug: 'vitan', role: 'owner' }];
      st.loadTeam = vi.fn(async () => {});
      st.loadOrgMembers = vi.fn();
    });
    render(<TeamScreen />);
    const add = screen.getByTestId('add-org-member');
    const roleSelect = screen.getByLabelText('Org role') as HTMLSelectElement;
    fireEvent.change(roleSelect, { target: { value: 'member' } });
    expect(add.textContent).toBe(' Add member');
    fireEvent.change(roleSelect, { target: { value: 'admin' } });
    expect(add.textContent).toBe(' Add admin');
  });
});
