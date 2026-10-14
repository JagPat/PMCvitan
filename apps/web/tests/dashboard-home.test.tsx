import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { selectDecisionsAwaitingAction } from '@/store/selectors';
import { screensFor } from '@/lib/screens';
import { DashboardScreen } from '@/screens/DashboardScreen';
import type { ApiGateway } from '@/data/apiGateway';

/**
 * #811 (Board decision 2026-10-13) — everyone lands on the Dashboard after login. Every role's home is the
 * Dashboard, and each part of it shows only to a role that holds where it leads: the review queue is served to
 * the PMC alone, and no tile or button opens a screen the viewer would be bounced from.
 */
const s = () => useStore.getState();
const ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor', 'consultant', 'architect'];

beforeEach(() => useStore.setState(getInitialState()));
afterEach(() => { cleanup(); useStore.getState()._setGateway(null); });

describe('the Dashboard is every role’s home', () => {
  it('is the first screen of every role, with For You still in the nav', () => {
    for (const role of ROLES) {
      const keys = screensFor(role).map((m) => m.key);
      expect(keys[0], role).toBe('dashboard');
      expect(keys, role).toContain('inbox');
    }
  });

  it('a persona switch lands every role on the Dashboard', () => {
    for (const role of ['pmc', 'client', 'engineer', 'contractor'] as Role[]) {
      s().setRole(role);
      expect(s().screen, role).toBe('dashboard');
    }
  });
});

describe('the Dashboard shows each role only what it can open', () => {
  it('the PMC keeps every tile and the Schedule button', () => {
    useStore.setState((st) => { st.role = 'pmc'; });
    const r = render(<DashboardScreen />);
    for (const key of ['pending', 'review', 'failed', 'photos']) expect(r.getByTestId(`tile-${key}`)).toBeInTheDocument();
    expect(r.getByText(/View Schedule/)).toBeInTheDocument();
  });

  it('a contractor sees no review-queue tiles and no Schedule button; its tiles open screens it holds', () => {
    useStore.setState((st) => { st.role = 'contractor'; });
    const r = render(<DashboardScreen />);
    expect(r.queryByTestId('tile-review')).not.toBeInTheDocument();
    expect(r.queryByTestId('tile-failed')).not.toBeInTheDocument();
    expect(r.queryByText(/View Schedule/)).not.toBeInTheDocument();
    fireEvent.click(r.getByTestId('tile-pending'));
    expect(s().screen).toBe('decision-log');
    fireEvent.click(r.getByTestId('tile-photos'));
    expect(s().screen).toBe('places');
  });

  it('every tile a role sees opens a screen that role may be routed to', () => {
    for (const role of ROLES) {
      cleanup();
      useStore.setState(getInitialState());
      useStore.setState((st) => { st.role = role; st.screen = 'dashboard'; });
      const r = render(<DashboardScreen />);
      const allowed = new Set(screensFor(role).map((m) => m.key));
      for (const tile of r.container.querySelectorAll('button[data-testid^="tile-"]')) {
        useStore.setState((st) => { st.screen = 'dashboard'; });
        fireEvent.click(tile);
        expect(allowed.has(s().screen), `${role} → ${tile.getAttribute('data-testid')} → ${s().screen}`).toBe(true);
      }
    }
  });

  it('the approvals tile opens the approval screen for a decider, and the Decision Log for the PMC', () => {
    // #818 Codex 4255468689 — the client's count is decisions awaiting the client, so its tile opens the screen
    // with the approval controls, as the action queue does; the PMC's count includes other deciders' decisions
    useStore.setState((st) => { st.role = 'client'; });
    expect(selectDecisionsAwaitingAction(s()).length).toBeGreaterThan(0);
    let r = render(<DashboardScreen />);
    fireEvent.click(r.getByTestId('tile-pending'));
    expect(s().screen).toBe('client-decisions');
    cleanup();
    useStore.setState((st) => { st.role = 'pmc'; st.screen = 'dashboard'; });
    r = render(<DashboardScreen />);
    fireEvent.click(r.getByTestId('tile-pending'));
    expect(s().screen).toBe('decision-log');
  });

  it('while the decisions are unsettled, the client\'s approvals tile opens the read-only /decisions path (#857 Codex 4269224400)', () => {
    useStore.setState((st) => { st.role = 'client'; st.commandReconcileOwed.decisions = true; });
    let r = render(<DashboardScreen />);
    fireEvent.click(r.getByTestId('tile-pending'));
    expect(s().screen).toBe('decision-log');
    // ...but not into a Decisions module the project switched off (#822)
    cleanup();
    useStore.setState((st) => { st.screen = 'dashboard'; st.enabledModules = ['daily-log', 'drawings', 'orgs', 'nodes']; });
    r = render(<DashboardScreen />);
    expect(r.getByTestId('tile-pending').tagName).toBe('DIV');
  });

  it('a module the project switched off offers no Dashboard way in (#822)', () => {
    // the shell's enabledModules omit activities, inspections, decisions and nodes: the nav hides their screens,
    // so the Dashboard shows no Schedule button, no review-queue tiles, and its decisions and photos tiles are
    // plain boxes rather than links into a disabled module
    useStore.setState((st) => { st.role = 'pmc'; st.enabledModules = ['daily-log', 'drawings', 'orgs']; });
    const r = render(<DashboardScreen />);
    expect(r.queryByText(/View Schedule/)).not.toBeInTheDocument();
    expect(r.queryByTestId('tile-review')).not.toBeInTheDocument();
    expect(r.queryByTestId('tile-failed')).not.toBeInTheDocument();
    expect(r.getByTestId('tile-pending').tagName).toBe('DIV');
    expect(r.getByTestId('tile-photos').tagName).toBe('DIV');
  });

  it('a decider with pending decisions gets no way into a Decisions module the project switched off (#822)', () => {
    // #823 Codex 4257107716 — the nav adds the approval screen for a viewer who decides something; that must not
    // reopen a module the project disabled, so the client's approvals tile stays a plain box
    useStore.setState((st) => { st.role = 'client'; st.enabledModules = ['daily-log', 'drawings', 'orgs', 'nodes']; });
    expect(selectDecisionsAwaitingAction(s()).length).toBeGreaterThan(0);
    const r = render(<DashboardScreen />);
    expect(r.getByTestId('tile-pending').tagName).toBe('DIV');
  });

  it('a project switch drops the previous project’s module set before the next shell reports (#822)', () => {
    // #823 Codex 4257275282 — enabledModules are project-owned: switching away from a project with modules off
    // must not hide the next project's Schedule or approvals while its own shell is still loading or has failed
    const gw = { switchProject: vi.fn().mockReturnValue(new Promise(() => {})) };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => {
      st.role = 'pmc';
      st.activeProjectId = 'project-a';
      st.enabledModules = ['daily-log', 'drawings', 'orgs'];
      st.memberships = [{ projectId: 'project-b', name: 'B', short: 'B', role: 'pmc', orgId: 'o', orgName: 'V' }];
    });
    void s().switchProject('project-b');
    expect(s().enabledModules).toEqual([]);
    const r = render(<DashboardScreen />);
    expect(r.getByText(/View Schedule/)).toBeInTheDocument();
  });

  it('a failed project switch keeps the old project’s module set (#824)', async () => {
    // #823 Codex 4257419886 — the switch empties the module set up front; when the server refuses it, the old
    // project stays active and its shell is not reloaded, so its own module set must come back with its identity
    const gw = { switchProject: vi.fn().mockRejectedValue(new Error('forbidden')) };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => {
      st.role = 'pmc';
      st.activeProjectId = 'project-a';
      st.enabledModules = ['daily-log', 'drawings', 'orgs'];
      st.memberships = [{ projectId: 'project-b', name: 'B', short: 'B', role: 'pmc', orgId: 'o', orgName: 'V' }];
    });
    expect(await s().switchProject('project-b')).toBe(false);
    expect(s().activeProjectId).toBe('project-a');
    expect(s().enabledModules).toEqual(['daily-log', 'drawings', 'orgs']);
    const r = render(<DashboardScreen />);
    expect(r.queryByText(/View Schedule/)).not.toBeInTheDocument();
  });

  it('the engineer keeps the Schedule button, which it holds, but not the review queue', () => {
    useStore.setState((st) => { st.role = 'engineer'; });
    const r = render(<DashboardScreen />);
    expect(r.getByText(/View Schedule/)).toBeInTheDocument();
    expect(r.queryByTestId('tile-review')).not.toBeInTheDocument();
  });
});
