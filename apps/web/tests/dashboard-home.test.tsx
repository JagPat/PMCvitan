import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { selectDecisionsAwaitingAction } from '@/store/selectors';
import { screensFor } from '@/lib/screens';
import { DashboardScreen } from '@/screens/DashboardScreen';

/**
 * #811 (Board decision 2026-10-13) — everyone lands on the Dashboard after login. Every role's home is the
 * Dashboard, and each part of it shows only to a role that holds where it leads: the review queue is served to
 * the PMC alone, and no tile or button opens a screen the viewer would be bounced from.
 */
const s = () => useStore.getState();
const ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor', 'consultant', 'architect'];

beforeEach(() => useStore.setState(getInitialState()));
afterEach(cleanup);

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

  it('the engineer keeps the Schedule button, which it holds, but not the review queue', () => {
    useStore.setState((st) => { st.role = 'engineer'; });
    const r = render(<DashboardScreen />);
    expect(r.getByText(/View Schedule/)).toBeInTheDocument();
    expect(r.queryByTestId('tile-review')).not.toBeInTheDocument();
  });
});
